'use strict';

const miio = require('miio');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiPowerStripPlatform';
const PLUGIN_NAME = 'homebridge-xiaomi-powerstrip-km81';

// MIoT (신규) 기본 매핑
const PROP_SWITCH = { siid: 2, piid: 1 };    // switch:on
const PROP_POWER_W = { siid: 3, piid: 1 };   // power-consumption:surge-power

module.exports = (api) => {
  PlatformAccessory = api.platformAccessory;
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform(PLATFORM_NAME, XiaomiPowerStripPlatform);
};

class XiaomiPowerStripPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    this.log.info('[Xiaomi Power Strip] 플랫폼 초기화');
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.log.info(`[Xiaomi Power Strip] 캐시 악세서리 로드: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const devices = this.config.deviceCfgs || [];
    const found = new Set();

    for (const cfg of devices) {
      if (!cfg || !cfg.ip || !cfg.token || !cfg.name) {
        this.log.warn('[Xiaomi Power Strip] 설정에 name/ip/token 누락됨 → 건너뜀');
        continue;
      }
      const uuid = UUIDGen.generate(cfg.ip);
      let acc = this.accessories.find(a => a.UUID === uuid);

      if (acc) {
        this.log.info(`[Xiaomi Power Strip] 기존 악세서리 복원: ${acc.displayName}`);
        acc.context.device = cfg;
        new SingleSwitchDevice(this, acc);
      } else {
        this.log.info(`[Xiaomi Power Strip] 새 악세서리 추가: ${cfg.name}`);
        acc = new PlatformAccessory(cfg.name, uuid);
        acc.context.device = cfg;
        new SingleSwitchDevice(this, acc);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.push(acc);
      }
      found.add(uuid);
    }

    const toRemove = this.accessories.filter(a => !found.has(a.UUID));
    if (toRemove.length) {
      this.log.info(`[Xiaomi Power Strip] 사용하지 않는 악세서리 ${toRemove.length}개 등록 해제`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
      this.accessories = this.accessories.filter(a => !toRemove.includes(a));
    }
  }
}

class SingleSwitchDevice {
  constructor(platform, accessory) {
    this.platform = platform;
    this.api = platform.api;
    this.log = platform.log;
    this.accessory = accessory;
    this.cfg = accessory.context.device || {};
    this.device = null;

    this.state = { on: false, powerW: undefined };
    this.pollInterval = null;
    this.pollingMs = Math.max(3000, Number(this.cfg.pollingInterval ?? 15000));

    // 통신 모드 자동감지 (초기엔 'auto' → miot 시도 후 실패 시 legacy로 전환)
    this.mode = 'auto'; // 'miot' | 'legacy'

    // Accessory Info
    const info = this.accessory.getService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
        .setCharacteristic(Characteristic.Model, 'PowerStrip (Unified Switch, AutoDetect)')
        .setCharacteristic(Characteristic.SerialNumber, this.cfg.serialNumber || this.cfg.ip || 'Unknown');

    // 단일 Switch 서비스
    this.switchService =
      this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch, this.cfg.name);

    // On setter
    this.switchService.getCharacteristic(Characteristic.On).onSet(async (value) => {
      try {
        if (this.mode === 'legacy') {
          await this.legacySetPower(!!value);
        } else {
          await this.miotSet(PROP_SWITCH, !!value);
        }
      } catch (e) {
        this.log.error(this.prefix(`전원 설정 실패: ${e.message}`));
        throw e;
      }
    });

    // 연결 및 폴링
    this.connect();

    this.api.on('shutdown', () => {
      if (this.pollInterval) clearInterval(this.pollInterval);
      if (this.device && this.device.destroy) {
        try { this.device.destroy(); } catch (_) {}
      }
    });
  }

  prefix(msg) { return `[${this.cfg.name}] ${msg}`; }
  key(p) { return `${p.siid}.${p.piid}`; }

  async connect() {
    try {
      this.log.info(this.prefix(`연결 시도... (${this.cfg.ip})`));
      this.device = await miio.device({ address: this.cfg.ip, token: this.cfg.token });
      this.log.info(this.prefix('연결 성공'));

      if (this.pollInterval) clearInterval(this.pollInterval);
      await this.poll(); // auto-detect 포함
      this.pollInterval = setInterval(() => this.poll(), this.pollingMs);
    } catch (e) {
      this.log.error(this.prefix(`연결 실패 (30초 후 재시도): ${e.message}`));
      setTimeout(() => this.connect(), 30000);
    }
  }

  async poll() {
    if (!this.device) return;

    // 모드가 legacy로 이미 확정이면 바로 legacy 폴링
    if (this.mode === 'legacy') {
      return this.legacyPoll();
    }

    // 1) MIoT 먼저 시도
    try {
      const req = [{ siid: PROP_SWITCH.siid, piid: PROP_SWITCH.piid }, { siid: PROP_POWER_W.siid, piid: PROP_POWER_W.piid }];
      const res = await this.device.call('get_properties', req);

      const map = {};
      if (Array.isArray(res) && res.length && typeof res[0] === 'object') {
        res.forEach(r => map[`${r.siid}.${r.piid}`] = r.value);
      } else {
        res.forEach((v, i) => map[`${req[i].siid}.${req[i].piid}`] = v);
      }

      const on = !!map[this.key(PROP_SWITCH)];
      const powerW = map[this.key(PROP_POWER_W)];
      this.state.on = on;
      this.state.powerW = (typeof powerW === 'number') ? powerW : undefined;

      this.switchService.updateCharacteristic(Characteristic.On, on);

      // 성공했으니 모드 확정
      if (this.mode === 'auto') this.mode = 'miot';
      return;
    } catch (e) {
      // get_properties 미지원 → legacy로 전환
      const msg = `${e?.message || e}`;
      if (this.mode !== 'legacy' && /get_properties.*not supported|Method.*not supported|-32601/i.test(msg)) {
        this.mode = 'legacy';
        this.log.warn(this.prefix('MIoT(get_properties) 미지원 → Legacy(get_prop) 모드로 전환'));
        return this.legacyPoll();
      } else {
        this.log.error(this.prefix(`상태 폴링 실패: ${msg}`));
      }
    }
  }

  // ===== MIoT set =====
  async miotSet(prop, value) {
    if (!this.device) throw new Error('Device not connected');
    const payload = [{ siid: prop.siid, piid: prop.piid, value }];
    const res = await this.device.call('set_properties', payload);
    if (Array.isArray(res)) {
      const ok = res.every(r => (typeof r === 'string' && r === 'ok') || (typeof r === 'object' && r.code === 0));
      if (!ok) throw new Error(`기기 응답 오류: ${JSON.stringify(res)}`);
    } else if (res !== 'ok') {
      throw new Error(`기기 응답 오류: ${String(res)}`);
    }
    setTimeout(() => this.poll(), 250);
  }

  // ===== Legacy (miIO) support =====
  // 다양한 플러그 변형을 고려해 다중 키를 조회
  get legacyStatusKeys() {
    // 가장 흔한 키 조합 우선
    return [
      ['on', 'power_consume_rate'],
      ['power', 'power_consume_rate'],
      ['on'],
      ['power']
    ];
  }

  normalizeBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v.toLowerCase() === 'on' || v === '1' || v === 'true';
    return false;
    }

  async legacyPoll() {
    try {
      let resp = null;
      let keysTried = null;

      // 키 조합을 순차적으로 시도
      for (const keys of this.legacyStatusKeys) {
        try {
          resp = await this.device.call('get_prop', keys);
          if (Array.isArray(resp) && resp.length > 0) {
            keysTried = keys;
            break;
          }
        } catch (_) { /* 다음 키 조합 시도 */ }
      }

      if (!resp) {
        throw new Error('get_prop 실패(지원 키 미탐색)');
      }

      // 응답 매핑
      let on = this.state.on;
      let powerW = this.state.powerW;

      // 배열 순서대로 값을 해석
      keysTried.forEach((k, idx) => {
        const val = resp[idx];
        if (k === 'on' || k === 'power') on = this.normalizeBool(val);
        if (k === 'power_consume_rate' && typeof val !== 'undefined') {
          const n = Number(val);
          powerW = Number.isFinite(n) ? n : undefined;
        }
      });

      this.state.on = !!on;
      this.state.powerW = powerW;

      this.switchService.updateCharacteristic(Characteristic.On, !!on);
    } catch (e) {
      this.log.error(this.prefix(`(Legacy) 상태 폴링 실패: ${e.message}`));
    }
  }

  async legacySetPower(value) {
    // 대부분 set_power('on'|'off'), 일부는 'toggle'도 존재하지만 여기선 표준 호출
    const arg = value ? 'on' : 'off';
    const res = await this.device.call('set_power', [arg]);
    if (res !== 'ok' && !(Array.isArray(res) && res[0] === 'ok')) {
      throw new Error(`set_power 실패: ${JSON.stringify(res)}`);
    }
    setTimeout(() => this.poll(), 250);
  }
}
