const miio = require('miio');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiPowerStripPlatform';
const PLUGIN_NAME = '@km81/homebridge-xiaomi-powerstrip';

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
    this.log.info(`[샤오미 멀티탭] 플랫폼 초기화`);
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  configureAccessory(accessory) {
    this.log.info(`[샤오미 멀티탭] 캐시 악세서리 로드: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const configuredDevices = this.config.deviceCfgs || [];
    const foundMainUUIDs = new Set();

    for (const deviceConfig of configuredDevices) {
      if (!deviceConfig || !deviceConfig.ip || !deviceConfig.token || !deviceConfig.name) {
        this.log.warn('[샤오미 멀티탭] 설정 항목에 ip/token/name 누락이 있어 건너뜁니다.');
        continue;
      }

      const uuid = UUIDGen.generate(deviceConfig.ip);
      const existingAccessory = this.accessories.find((acc) => acc.UUID === uuid);

      if (existingAccessory) {
        this.log.info(`[샤오미 멀티탭] 기존 악세서리 복원: ${existingAccessory.displayName}`);
        existingAccessory.context.device = deviceConfig;
        existingAccessory.context.isChild = false;
        new DeviceHandler(this, existingAccessory);
        foundMainUUIDs.add(existingAccessory.UUID);
      } else {
        this.log.info(`[샤오미 멀티탭] 새 악세서리 추가: ${deviceConfig.name}`);
        const accessory = new PlatformAccessory(deviceConfig.name, uuid);
        accessory.context.device = deviceConfig;
        accessory.context.isChild = false;
        new DeviceHandler(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        foundMainUUIDs.add(accessory.UUID);
      }
    }

    // 메인 악세서리만 정리
    const accessoriesToUnregister = this.accessories.filter(
      (acc) => acc.context?.isChild !== true && !foundMainUUIDs.has(acc.UUID)
    );
    if (accessoriesToUnregister.length > 0) {
      this.log.info(`[샤오미 멀티탭] 사용하지 않는 메인 악세서리 ${accessoriesToUnregister.length}개 등록 해제`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToUnregister);
      this.accessories = this.accessories.filter((acc) => !accessoriesToUnregister.includes(acc));
    }
  }
}

class DeviceHandler {
  constructor(platform, accessory) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.config = accessory.context.device || {};
    this.device = null;
    this.state = {};
    this.pollInterval = null;

    this.outlets = Array.isArray(this.config.outlets) && this.config.outlets.length > 0
      ? this.config.outlets
      : [{ name: this.config.name, siid: 2, piid: 1 }];
    this.temperatureProp = this.config.temperature || { siid: 2, piid: 2 };
    this.powerProp = this.config.power || { siid: 3, piid: 1 };
    this.ledProp = this.config.led || { siid: 4, piid: 1 };
    this.showTemperature = this.config.showTemperature !== false;
    this.showLED = this.config.showLED !== false;
    this.separateTemperatureAccessory = this.config.separateTemperatureAccessory === true;
    this.separateLedAccessory = this.config.separateLedAccessory === true;
    this.separateOutletAccessories = (this.config.separateOutletAccessories === true) || (this.outlets.length > 1);
    this.useSwitchInsteadOfOutlet = this.config.useSwitchInsteadOfOutlet === true;
    this.powerInUseThreshold = Number(this.config.powerInUseThreshold ?? 1.0);
    this.pollingMs = Math.max(3000, Number(this.config.pollingInterval ?? 15000));

    this.children = { temp: null, led: null };
    this.outletSvcs = [];

    this.setupServices();
    this.connect();
  }

  prefix(msg) { return `[${this.config.name}] ${msg}`; }
  getChildUUID(suffix) { return UUIDGen.generate(`${this.config.ip}-${suffix}`); }

  buildPropKey(obj) { return `${obj.siid}.${obj.piid}`; }

  async miotGet(props) {
    if (!this.device) throw new Error('Device not connected');
    const list = props.map(p => ({ siid: p.siid, piid: p.piid }));
    const res = await this.device.call('get_properties', list);
    if (Array.isArray(res) && res.length && typeof res[0] === 'object') {
      const map = {};
      res.forEach(r => map[`${r.siid}.${r.piid}`] = r.value);
      return map;
    } else {
      const map = {};
      res.forEach((v, i) => map[`${props[i].siid}.${props[i].piid}`] = v);
      return map;
    }
  }

  async miotSet(prop, value) {
    if (!this.device) throw new Error('Device not connected');
    const payload = [{ siid: prop.siid, piid: prop.piid, value }];
    const res = await this.device.call('set_properties', payload);
    if (Array.isArray(res)) {
      const ok = res.every(r => (typeof r === 'string' && r === 'ok') || (typeof r === 'object' && r.code === 0));
      if (!ok) throw new Error(`기기 오류: ${JSON.stringify(res)}`);
    } else if (res !== 'ok') {
      throw new Error(`기기 오류: ${String(res)}`);
    }
    setTimeout(() => this.pollDeviceState(), 250);
  }

  async connect() {
    try {
      this.log.info(this.prefix(`연결 시도... (${this.config.ip})`));
      this.device = await miio.device({ address: this.config.ip, token: this.config.token });
      this.log.info(this.prefix('연결 성공'));
      clearInterval(this.pollInterval);
      this.pollDeviceState();
      this.pollInterval = setInterval(() => this.pollDeviceState(), this.pollingMs);
    } catch (e) {
      this.log.error(this.prefix(`연결 실패 (30초 후 재시도): ${e.message}`));
      setTimeout(() => this.connect(), 30000);
    }
  }

  async pollDeviceState() {
    if (!this.device) return;
    try {
      const props = [];
      for (const o of this.outlets) props.push({ siid: o.siid, piid: o.piid });
      if (this.showTemperature && this.temperatureProp?.siid && this.temperatureProp?.piid) props.push(this.temperatureProp);
      if (this.powerProp?.siid && this.powerProp?.piid) props.push(this.powerProp);
      if (this.showLED && this.ledProp?.siid && this.ledProp?.piid) props.push(this.ledProp);

      const map = await this.miotGet(props);
      this.outlets.forEach((o, i) => {
        const key = this.buildPropKey(o);
        this.state[`outlet_${i}_on`] = !!map[key];
      });
      if (this.showTemperature) {
        const tKey = this.buildPropKey(this.temperatureProp);
        const tVal = map[tKey];
        this.state.temperature = (typeof tVal === 'number') ? tVal : Number(tVal);
      }
      if (this.powerProp?.siid) {
        const pKey = this.buildPropKey(this.powerProp);
        const pVal = map[pKey];
        this.state.powerW = (typeof pVal === 'number') ? pVal : Number(pVal);
      }
      if (this.showLED) {
        const lKey = this.buildPropKey(this.ledProp);
        this.state.ledOn = !!map[lKey];
      }
      this.updateAllCharacteristics();
    } catch (e) {
      this.log.error(this.prefix(`상태 폴링 실패: ${e.message}`));
    }
  }

  setServiceName(service, name) {
    try { service.updateCharacteristic(Characteristic.Name, name); } catch (_) {}
    try { if (Characteristic.ConfiguredName) service.updateCharacteristic(Characteristic.ConfiguredName, name); } catch (_) {}
  }

  setupServices() {
    this.setupAccessoryInfo();
    this.outlets.forEach((o, i) => {
      const name = o.name || `${this.config.name} Outlet ${i+1}`;
      const type = this.useSwitchInsteadOfOutlet ? Service.Switch : Service.Outlet;
      const svc = this.accessory.getServiceById(type, `Outlet-${i}`) || this.accessory.addService(type, name, `Outlet-${i}`);
      this.setServiceName(svc, name);
      this.outletSvcs[i] = { acc: this.accessory, svc, outletIdx: i };
      svc.getCharacteristic(Characteristic.On).onSet(async (v) => {
        try {
          await this.miotSet(this.outlets[i], !!v);
        } catch (e) {
          this.log.error(this.prefix(`채널${i+1} On 설정 실패: ${e.message}`));
          throw e;
        }
      });
    });
  }

  setupAccessoryInfo() {
    const info = this.accessory.getService(Service.AccessoryInformation
