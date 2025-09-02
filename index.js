'use strict';

const miio = require('miio');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiPowerStripPlatform';
const PLUGIN_NAME = 'homebridge-xiaomi-powerstrip-km81';

// MIoT 기본 매핑 (가능하면 사용)
const PROP_SWITCH = { siid: 2, piid: 1 };   // switch:on
const PROP_POWER_W = { siid: 3, piid: 1 };  // power-consumption:surge-power

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

    // 통신 모드: auto → miot 우선, 실패 시 legacy
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

    // On setter (낙관적 업데이트 + 모드별 제어)
    this.switchService.getCharacteristic(Characteristic.On).onSet(async (value) => {
      const boolVal = !!value;
      try {
        // 낙관적으로 먼저 반영 (폴링 실패 시 되돌아가는 현상 방지)
        this.state.on = boolVal;
        this.switchService.updateCharacteristic(Characteristic.On, boolVal);

        if (this.mode === 'legacy') {
          await this.legacySetPower(boolVal);
        } else {
          await this.miotSet(PROP_SWITCH, boolVal);
        }
      } catch (e) {
        this.log.error(this.prefix(`전원 설정 실패: ${e.message}`));
        // 실패 시 한 번 더 폴링하여 실제 상태 동기화
        setTimeout(() => this.poll(), 400);
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

  // ===== 폴링 =====
  async poll() {
    if (!this.device) return;

    if (this.mode === 'legacy') {
      return this.legacyPoll();
    }

    // 1) MIoT 먼저 시도
    try {
      const req = [
        { siid: PROP_SWITCH.siid, piid: PROP_SWITCH.piid },
        { siid: PROP_POWER_W.siid, piid: PROP_POWER_W.piid }
      ];
      const res = await this.device.call('get_properties', req);

      const map = {};
      if (Array.isArray(res) && res.length && typeof res[0] === 'object') {
        res.forEach(r => map[`${r.siid}.${r.piid}`] = r.value);
      } else {
        res.forEach((v, i) => map[`${req[i].siid}.${req[i].piid}`] = v);
      }

      const onVal = map[this.key(PROP_SWITCH)];
      const powerW = map[this.key(PROP_POWER_W)];
      const on = typeof onVal !== 'undefined' ? !!onVal : this.state.on; // 값 없으면 유지
      this.state.on = on;
      this.state.powerW = (typeof powerW === 'number') ? powerW : this.state.powerW;

      this.switchService.updateCharacteristic(Characteristic.On, on);

      if (this.mode === 'auto') this.mode = 'miot';
      return;
    } catch (e) {
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

  // ===== Legacy (miIO) =====
  // 상태 조회를 위한 키/메서드 후보들
  get legacyKeyCombos() {
    // 가장 일반적인 조합부터
    return [
      { method: 'get_prop', keys: ['on', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['power', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['relay_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['switch', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['state', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['enable'] },
      { method: 'get_prop', keys: ['on'] },
      { method: 'get_prop', keys: ['power'] },
      { method: 'get_status', keys: [] }, // 일부 기기는 객체/맵 반환
      { method: 'get_power', keys: [] }   // 일부 기기는 단일 전원 상태만 반환
    ];
  }

  normalizeBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      return s === 'on' || s === 'true' || s === '1';
    }
    return false;
  }

  async legacyPoll() {
    let on = undefined;
    let powerW = this.state.powerW;

    for (const combo of this.legacyKeyCombos) {
      try {
        let resp = await this.device.call(combo.method, combo.keys);
        // 다양한 응답 형태를 처리
        if (Array.isArray(resp)) {
          // 키와 1:1 매핑
          combo.keys.forEach((k, idx) => {
            const val = resp[idx];
            if (k === 'on' || k === 'power' || k === 'relay_status' || k === 'switch' || k === 'state' || k === 'enable') {
              on = this.normalizeBool(val);
            }
            if (k === 'power_consume_rate' && typeof val !== 'undefined') {
              const n = Number(val);
              if (Number.isFinite(n)) powerW = n;
            }
          });
        } else if (typeof resp === 'object' && resp !== null) {
          // 객체 맵
          const cand = resp.on ?? resp.power ?? resp.relay_status ?? resp.switch ?? resp.state ?? resp.enable;
          if (typeof cand !== 'undefined') on = this.normalizeBool(cand);
          const pw = resp.power_consume_rate ?? resp.load_power ?? resp.all_power;
          if (typeof pw !== 'undefined') {
            const n = Number(pw);
            if (Number.isFinite(n)) powerW = n;
          }
        } else if (typeof resp === 'string' || typeof resp === 'number' || typeof resp === 'boolean') {
          // 단일 값 (get_power 류)
          on = this.normalizeBool(resp);
        }

        // 성공적으로 on 값을 결정했다면 종료
        if (typeof on !== 'undefined') break;
      } catch (_) {
        // 다음 후보 시도
      }
    }

    // on 값을 아직도 못 구했으면 기존 상태 유지
    if (typeof on === 'undefined') on = this.state.on;

    this.state.on = !!on;
    this.state.powerW = powerW;

    // 홈킷에 반영
    try { this.switchService.updateCharacteristic(Characteristic.On, !!on); } catch (_) {}
  }

  async legacySetPower(value) {
    const arg = value ? 'on' : 'off';

    // 1) 표준
    try {
      const res = await this.device.call('set_power', [arg]);
      if (res === 'ok' || (Array.isArray(res) && res[0] === 'ok')) {
        setTimeout(() => this.poll(), 250);
        return;
      }
    } catch (_) {}

    // 2) set_on(true/false)
    try {
      const res2 = await this.device.call('set_on', [!!value]);
      if (res2 === 'ok' || (Array.isArray(res2) && res2[0] === 'ok')) {
        setTimeout(() => this.poll(), 250);
        return;
      }
    } catch (_) {}

    // 3) toggle_plug (value가 true면 on, false면 off와 동일 효과가 있는 모델도 있어 대부분 on/off 1회 호출로 대체)
    try {
      if (value) {
        const res3 = await this.device.call('toggle_plug', []);
        if (res3 === 'ok' || (Array.isArray(res3) && res3[0] === 'ok')) {
          setTimeout(() => this.poll(), 250);
          return;
        }
      }
    } catch (_) {}

    throw new Error('set_power / set_on / toggle_plug 모두 실패');
  }
}
