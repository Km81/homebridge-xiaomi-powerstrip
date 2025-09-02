'use strict';

const miio = require('miio');

let PlatformAccessory, Service, Characteristic, UUIDGen;

const PLATFORM_NAME = 'XiaomiPowerStripPlatform';
const PLUGIN_NAME = 'homebridge-xiaomi-powerstrip-km81';

// MIoT 기본 매핑
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

    // 모드: 'auto' | 'miot' | 'legacy'
    this.mode = (this.cfg.protocolMode || 'auto').toLowerCase();
    this.debugEnabled = !!this.cfg.debug;
    this.dlog = (...args) => { if (this.debugEnabled) this.log.info(this.prefix('[DEBUG]'), ...args); };

    // Accessory Info
    const info = this.accessory.getService(Service.AccessoryInformation);
    info.setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
        .setCharacteristic(Characteristic.Model, 'PowerStrip (Unified Switch, AutoDetect)')
        .setCharacteristic(Characteristic.SerialNumber, this.cfg.serialNumber || this.cfg.ip || 'Unknown');

    // 단일 Switch 서비스
    this.switchService =
      this.accessory.getService(Service.Switch) ||
      this.accessory.addService(Service.Switch, this.cfg.name);

    // On setter (낙관적 업데이트)
    this.switchService.getCharacteristic(Characteristic.On).onSet(async (value) => {
      const boolVal = !!value;
      try {
        this.state.on = boolVal; // optimistic
        this.switchService.updateCharacteristic(Characteristic.On, boolVal);

        if (this.mode === 'legacy') {
          await this.legacySetPower(boolVal);
        } else {
          await this.miotSet(PROP_SWITCH, boolVal);
        }
      } catch (e) {
        this.log.error(this.prefix(`전원 설정 실패: ${e.message}`));
        setTimeout(() => this.poll(), 400);
        throw e;
      }
    });

    // 연결 및 폴링
    this.connect();

    this.api.on('shutdown', () => {
      if (this.pollInterval) clearInterval(this.pollInterval);
      if (this.device && this.device.destroy) { try { this.device.destroy(); } catch (_) {} }
    });
  }

  prefix(msg) { return `[${this.cfg.name}] ${msg}`; }
  key(p) { return `${p.siid}.${p.piid}`; }
  safeJSON(obj) { try { return JSON.stringify(obj); } catch (_) { return String(obj); } }

  async connect() {
    try {
      this.log.info(this.prefix(`연결 시도... (${this.cfg.ip})`));
      // 참고 플러그인처럼 model을 넘길 수 있게
      // miio는 최신에선 miio.device(...)가 일반적이지만, 옵션 객체에 model 넣어도 무방
      this.device = await miio.device({
        address: this.cfg.ip,
        token: this.cfg.token,
        model: this.cfg.model // 선택값
      });
      // createDevice().init() 스타일 사용이 필요한 구버전 대응
      if (this.device && typeof this.device.init === 'function') {
        try { await this.device.init(); } catch (_) {}
      }

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

    if (this.mode === 'legacy') return this.legacyPoll();
    if (this.mode === 'miot')   return this.miotPoll();

    // auto: 먼저 miot, 실패 시 legacy
    try {
      await this.miotPoll();
      if (this.mode === 'auto') this.mode = 'miot';
    } catch (e) {
      const msg = `${e?.message || e}`;
      this.dlog('MIoT 폴링 오류:', msg);
      if (/get_properties.*not supported|Method.*not supported|-32601/i.test(msg)) {
        this.mode = 'legacy';
        this.log.warn(this.prefix('MIoT 미지원 → Legacy 모드 전환'));
        return this.legacyPoll();
      }
      this.log.error(this.prefix(`상태 폴링 실패(MIoT): ${msg}`));
    }
  }

  // ====== MIoT ======
  async miotPoll() {
    const req = [
      { siid: PROP_SWITCH.siid, piid: PROP_SWITCH.piid },
      { siid: PROP_POWER_W.siid, piid: PROP_POWER_W.piid }
    ];
    this.dlog('MIoT get_properties 요청:', this.safeJSON(req));
    const res = await this.device.call('get_properties', req);
    this.dlog('MIoT 응답:', this.safeJSON(res));

    const map = {};
    if (Array.isArray(res) && res.length && typeof res[0] === 'object') {
      res.forEach(r => map[`${r.siid}.${r.piid}`] = r.value);
    } else {
      res.forEach((v, i) => map[`${req[i].siid}.${req[i].piid}`] = v);
    }

    const onVal = map[this.key(PROP_SWITCH)];
    const powerW = map[this.key(PROP_POWER_W)];
    const on = (typeof onVal !== 'undefined') ? !!onVal : this.state.on;

    this.state.on = on;
    if (typeof powerW === 'number') this.state.powerW = powerW;

    this.switchService.updateCharacteristic(Characteristic.On, on);
  }

  async miotSet(prop, value) {
    if (!this.device) throw new Error('Device not connected');
    const payload = [{ siid: prop.siid, piid: prop.piid, value }];
    this.dlog('MIoT set_properties:', this.safeJSON(payload));
    const res = await this.device.call('set_properties', payload);
    this.dlog('MIoT set 응답:', this.safeJSON(res));

    if (Array.isArray(res)) {
      const ok = res.every(r => (typeof r === 'string' && r === 'ok') || (typeof r === 'object' && r.code === 0));
      if (!ok) throw new Error(`기기 응답 오류: ${this.safeJSON(res)}`);
    } else if (res !== 'ok') {
      throw new Error(`기기 응답 오류: ${String(res)}`);
    }
    setTimeout(() => this.poll(), 250);
  }

  // ====== Legacy ======
  // 0단계: 고수준 추상 메서드 우선 시도 (miio가 모델별로 적합한 RPC를 선택)
  async legacyHighLevelGetPower() {
    try {
      if (this.device && typeof this.device.power === 'function') {
        this.dlog('Legacy high-level power() 호출');
        const v = await this.device.power();   // boolean | "on"/"off" | number | undefined
        this.dlog('Legacy power() 응답:', this.safeJSON(v));
        const b = this.normalizeBool(v);
        return (typeof b !== 'undefined') ? b : undefined;
      }
    } catch (e) {
      this.dlog('power() 호출 오류:', e?.message || e);
    }
    return undefined;
  }

  async legacyHighLevelSetPower(value) {
    try {
      if (this.device && typeof this.device.setPower === 'function') {
        this.dlog('Legacy high-level setPower():', value);
        const r = await this.device.setPower(!!value);
        this.dlog('Legacy setPower 응답:', this.safeJSON(r));
        // 보통 'ok' 또는 true 반환
        return true;
      }
    } catch (e) {
      this.dlog('setPower() 호출 오류:', e?.message || e);
    }
    return false;
  }

  get legacyKeyCombos() {
    // 배열 응답의 첫 값이 상태, 두 번째가 전력인 조합들을 우선 시도.
    // (로그에서 'on'은 null이므로 'power'부터 시도)
    return [
      { method: 'get_prop', keys: ['power', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['relay_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['switch', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['state', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['enable', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['plug_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['plug_state', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['switch_status', 'power_consume_rate'] },
      { method: 'get_prop', keys: ['on', 'power_consume_rate'] }, // 당신 모델에선 null
      { method: 'get_status', keys: [] },
      { method: 'get_power',  keys: [] }
    ];
  }

  normalizeBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'on' || s === 'true' || s === '1') return true;
      if (s === 'off' || s === 'false' || s === '0') return false;
    }
    return undefined;
  }

  async legacyPoll() {
    // 0단계: 고수준 power()부터
    let on = await this.legacyHighLevelGetPower();
    let powerW = this.state.powerW;

    if (typeof on === 'undefined') {
      // 1단계: 키 조합 순차 시도
      let lastErr = null;

      for (const combo of this.legacyKeyCombos) {
        try {
          this.dlog('Legacy 요청:', combo.method, combo.keys);
          const resp = await this.device.call(combo.method, combo.keys);
          this.dlog('Legacy 응답:', this.safeJSON(resp));

          if (Array.isArray(resp)) {
            let anyUseful = false;
            combo.keys.forEach((k, idx) => {
              const val = resp[idx];
              if (['power','on','relay_status','switch','state','enable','plug_status','plug_state','switch_status'].includes(k)) {
                const b = this.normalizeBool(val);
                if (typeof b !== 'undefined') { on = b; anyUseful = true; }
              }
              if (k === 'power_consume_rate' && val != null) {
                const n = Number(val);
                if (Number.isFinite(n)) { powerW = n; anyUseful = true; }
              }
            });
            if (anyUseful && typeof on !== 'undefined') break;
            continue;
          }

          if (typeof resp === 'object' && resp !== null) {
            const cand = resp.power ?? resp.on ?? resp.relay_status ?? resp.switch ?? resp.state ?? resp.enable
                       ?? resp.plug_status ?? resp.plug_state ?? resp.switch_status;
            const b = this.normalizeBool(cand);
            if (typeof b !== 'undefined') on = b;

            const pw = resp.power_consume_rate ?? resp.load_power ?? resp.all_power;
            if (typeof pw !== 'undefined') {
              const n = Number(pw);
              if (Number.isFinite(n)) powerW = n;
            }
            if (typeof on !== 'undefined') break;
            continue;
          }

          const b = this.normalizeBool(resp);
          if (typeof b !== 'undefined') { on = b; break; }
        } catch (e) {
          lastErr = e;
        }
      }

      if (typeof on === 'undefined' && lastErr) {
        this.log.error(this.prefix(`(Legacy) 상태 폴링 실패: ${lastErr.message || lastErr}`));
      }
    }

    if (typeof on === 'undefined') on = this.state.on; // 여전히 모르면 유지

    this.state.on = !!on;
    this.state.powerW = powerW;

    try { this.switchService.updateCharacteristic(Characteristic.On, !!on); } catch (_) {}
  }

  async legacySetPower(value) {
    // 0단계: 고수준 setPower() 우선
    const ok = await this.legacyHighLevelSetPower(value);
    if (ok) { setTimeout(() => this.poll(), 250); return; }

    // 1단계: RPC 폴백
    const arg = value ? 'on' : 'off';
    try {
      this.dlog('Legacy set_power:', arg);
      const res = await this.device.call('set_power', [arg]);
      this.dlog('Legacy set_power 응답:', this.safeJSON(res));
      if (res === 'ok' || (Array.isArray(res) && res[0] === 'ok')) { setTimeout(() => this.poll(), 250); return; }
    } catch (e) { this.dlog('set_power 오류:', e?.message || e); }

    try {
      this.dlog('Legacy set_on:', value);
      const res2 = await this.device.call('set_on', [!!value]);
      this.dlog('Legacy set_on 응답:', this.safeJSON(res2));
      if (res2 === 'ok' || (Array.isArray(res2) && res2[0] === 'ok')) { setTimeout(() => this.poll(), 250); return; }
    } catch (e) { this.dlog('set_on 오류:', e?.message || e); }

    if (value) {
      try {
        this.dlog('Legacy toggle_plug');
        const res3 = await this.device.call('toggle_plug', []);
        this.dlog('Legacy toggle_plug 응답:', this.safeJSON(res3));
        if (res3 === 'ok' || (Array.isArray(res3) && res3[0] === 'ok')) { setTimeout(() => this.poll(), 250); return; }
      } catch (e) { this.dlog('toggle_plug 오류:', e?.message || e); }
    }

    throw new Error('setPower()/set_power/set_on/toggle_plug 모두 실패');
  }
}
