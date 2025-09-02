
# homebridge-xiaomi-powerstrip

샤오미 **멀티탭/플러그(MiOT 기반)**을 HomeKit에 연결하는 경량 Homebridge 플러그인입니다.  
여러 개의 콘센트(채널)를 **Outlet** 또는 **Switch** 서비스로 노출하고, **전력(W)로 In Use 판단**, **LED 스위치**, **온도 센서**를 제공합니다.

> 기본값은 MIoT 속성 매핑(예: `2.1 switch:on`, `2.2 temperature`, `3.1 surge-power`, `4.1 indicator-light:on`)을 사용합니다. 필요하면 설정에서 siid/piid를 바꾸어 사용하세요.

---

## 설치

```bash
npm i -g homebridge-xiaomi-powerstrip
```

---

## 설정 예시 (config.json)

```json
{
  "platforms": [
    {
      "platform": "XiaomiPowerStripPlatform",
      "deviceCfgs": [
        {
          "name": "책상 멀티탭",
          "ip": "192.168.1.50",
          "token": "YOUR_32_HEX_TOKEN",
          "serialNumber": "PS-001",
          "separateOutletAccessories": true,
          "outlets": [
            { "name": "채널1", "siid": 2, "piid": 1 }
          ],
          "temperature": { "siid": 2, "piid": 2 },
          "power": { "siid": 3, "piid": 1 },
          "led": { "siid": 4, "piid": 1 },
          "powerInUseThreshold": 1.0,
          "showTemperature": true,
          "separateTemperatureAccessory": false,
          "showLED": true,
          "separateLedAccessory": false,
          "useSwitchInsteadOfOutlet": false,
          "pollingInterval": 15000
        }
      ]
    }
  ]
}
```

---

## 주요 설정 항목
- **deviceCfgs[]**: 기기별 설정 배열
  - **ip / token / name**: 필수
  - **outlets[]**: 콘센트(채널) 목록. 각 항목은 `{ name, siid, piid }` 형태
  - **temperature**: `{ siid, piid }` (옵션) – 온도 센서 속성
  - **power**: `{ siid, piid }` (옵션) – 순간 전력(W), `Outlet.InUse` 판단에 사용
  - **led**: `{ siid, piid }` (옵션) – 표시등 on/off
  - **powerInUseThreshold**: 전력이 이 값보다 크면 `Outlet.InUse = true` (기본 1W)
  - **separateOutletAccessories**: 채널을 각각 별도 악세서리로 분리 (기본 true if 채널>1)
  - **useSwitchInsteadOfOutlet**: HomeKit **Switch** 서비스로 노출(기본 false → Outlet)
  - **showTemperature / separateTemperatureAccessory**: 온도 센서 표시/분리
  - **showLED / separateLedAccessory**: LED 스위치 표시/분리
  - **pollingInterval**: 상태 폴링 주기(ms, 기본 15000)

---

## 지원/제한
- **MIoT** `get_properties` / `set_properties`를 사용합니다.
- 일부 모델은 siid/piid가 다를 수 있습니다. 이상 동작 시 해당 기기의 MIoT 스펙을 확인하여 siid/piid를 맞춰주세요.
- 전력/온도 속성이 없는 모델은 해당 기능이 숨겨집니다.

---

## 크레딧
- 이 플러그인은 동일 저자의 공기청정기 플러그인 구조를 참고하여 작성되었습니다.
