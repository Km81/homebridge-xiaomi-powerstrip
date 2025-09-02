'use strict';

const miio = require('miio');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiPowerStripPlatform';
const PLUGIN_NAME = 'homebridge-xiaomi-powerstrip-km81';

// 고정된 MiOT 매핑 (단일 통합 스위치 모델 가정)
// 전원 on/off: siid 2, piid 1
// 순간 전력(W): siid 3, piid 1  (있으면 폴링 시 참고; 악세서리에는 노출 안함)
const PROP_SWITCH = { siid: 2, piid: 1 };
const PROP_POWER_W = { siid: 3, piid: 1 };

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

    // 사용하지 않는 메인 악세서리 정리
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

    // Accessory Info
    const info = this.accessory.getService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
        .setCharacteristic(Characteristic.Model, 'PowerStrip (Unified Switch)')
        .setCharacteristic(Characteristic.SerialNumber, this.cfg.serialNumber || this.cfg.ip || 'Unknown');

    // Service: Switch (단일)
    this.switchService =
      this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch, this.cfg.name);

    // On setter
    this.switchService.getCharacteristic(Characteristic.On).onSet(async (value) => {
      try {
        await this.miotSet(PROP_SWITCH, !!value);
      } catch (e) {
        this.log.error(this.prefix(`전원 설정 실패: ${e.message}`));
        throw e;
      }
    });

    // 연결 및 폴링 시작
    this.connect();

    // 종료 처리
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
      await this.poll();
      this.pollInterval = setInterval(() => this.poll(), this.pollingMs);
    } catch (e) {
      this.log.error(this.prefix(`연결 실패 (30초 후 재시도): ${e.message}`));
      setTimeout(() => this.connect(), 30000);
    }
  }

  async poll() {
    if (!this.device) return;
    try {
      const req = [{ siid: PROP_SWITCH.siid, piid: PROP_SWITCH.piid }];
      // 전력 속성은 기기가 지원할 때만 성공하므로, 실패해도 동작엔 영향 없음
      req.push({ siid: PROP_POWER_W.siid, piid: PROP_POWER_W.piid });

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

      // Update characteristic
      this.switchService.updateCharacteristic(Characteristic.On, on);
    } catch (e) {
      this.log.error(this.prefix(`상태 폴링 실패: ${e.message}`));
    }
  }

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

    // 반영 후 바로 상태 동기화
    setTimeout(() => this.poll(), 250);
  }
}
