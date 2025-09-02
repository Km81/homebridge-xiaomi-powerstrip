# homebridge-xiaomi-powerstrip-km81

Homebridge에서 **샤오미 멀티탭 / 스마트 플러그**를 제어할 수 있는 플러그인입니다.  
이 플러그인은 기기가 **MIoT 프로토콜**(get_properties/set_properties) 또는 **miIO 레거시 프로토콜**(get_prop/set_power)을 사용하는지 자동으로 감지하여 적절히 동작합니다.

## ✨ 주요 기능

- 샤오미 멀티탭/플러그를 HomeKit에서 **단일 스위치**로 제어
- MIoT ↔ miIO 프로토콜 자동 감지 및 전환
- 폴링 주기 설정 가능 (기본 15초, 최소 3초)
- 낙관적 업데이트(토글 시 상태가 되돌아가지 않도록 처리)
- 디버그 로그 옵션 제공 (지원하지 않는 메서드 확인용)
- 선택적으로 **기기 모델명 힌트**를 설정해 인식률 향상 (예: `zimi.powerstrip.v2`, `chuangmi.plug.v3`)

## 🔧 설치 방법

```bash
npm install -g homebridge-xiaomi-powerstrip-km81
```

또는 Homebridge UI에서 `homebridge-xiaomi-powerstrip-km81`를 검색하여 설치할 수 있습니다.

## ⚙️ 설정 예시

`config.json` 예시:

```json
{
  "platforms": [
    {
      "platform": "XiaomiPowerStripPlatform",
      "deviceCfgs": [
        {
          "name": "거실 멀티탭",
          "ip": "192.168.1.55",
          "token": "YOUR32CHARTOKENHEXHERE",
          "serialNumber": "123456789",
          "pollingInterval": 15000,
          "model": "zimi.powerstrip.v2",
          "protocolMode": "auto",
          "debug": false
        }
      ]
    }
  ]
}
```

### 설정 항목 설명

| 항목              | 타입    | 기본값   | 설명 |
|------------------|---------|---------|------|
| `name`           | string  | `"Xiaomi Power Strip"` | HomeKit에 표시될 이름 |
| `ip`             | string  | 필수     | 기기의 IP 주소 |
| `token`          | string  | 필수     | 32자리 HEX 토큰 (`miio` 툴 등으로 추출) |
| `serialNumber`   | string  | 선택     | Home 앱에 표시될 일련번호 |
| `pollingInterval`| int     | 15000    | 상태 폴링 주기(ms), 최소 3000 |
| `model`          | string  | 선택     | 기기 모델 힌트 (예: `chuangmi.plug.v3`) |
| `protocolMode`   | enum    | `auto`   | `auto`, `miot`, `legacy` 중 선택 |
| `debug`          | boolean | false    | 디버그 로그 출력 여부 |

## 🛠 문제 해결

- HomeKit에서 스위치를 켰는데 다시 꺼짐으로 돌아간다면 → `protocolMode`를 `legacy`로 설정하고 `debug`를 켜세요.  
  로그를 확인해 어떤 속성(`power`, `relay_status` 등)이 실제 상태를 반환하는지 확인할 수 있습니다.
- 특정 모델은 `model` 값을 직접 지정하면 인식률이 더 좋아집니다.

## 📌 참고 사항

- 이 플러그인은 **단일 스위치 제어용 샤오미 멀티탭 / 플러그**를 대상으로 최적화되어 있습니다.  
- 6구 멀티탭 등 다채널 제품도 **하나의 스위치로 통합 제어**됩니다 (개별 콘센트 제어는 불가).  
- LED 제어, 온도 센서 등은 단순화를 위해 노출하지 않습니다.

## 📜 라이선스

MIT © Km81
