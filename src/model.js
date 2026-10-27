// -----------------------------------------------------------------------------
// Known water timers -> Gladys devices and values (pure).
//
// One Gladys device per water timer (TapLinker, ValveLinker) of the gateway.
// External id (frozen): gladys.externalIds('linktap', <timer id>), the timer id
// the gateway lists in `end_dev` (16 letters or digits, `_<n>` for a sub-
// device), in upper case. Feature keys (frozen):
//   watering, remaining, battery, signal, rf_linked, plan_paused,
//   alert_high_flow, alert_low_flow, alert_water_cut, alert_fall,
//   alert_valve_failure (read only); flow, volume (read only, with a flow
//   meter); start, stop, pause_plan (BUTTONS).
//
// Watering is never a switch nor a commandable binary: a "turn everything
// on/off" (voice assistants, HomeKit, scenes on switches) must never open a
// valve.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE, LIMITS } from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';

const ALERTS = ['high_flow', 'low_flow', 'water_cut', 'fall', 'valve_failure'];

const binary = () => ({
  category: C.UNKNOWN,
  type: T.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});
const sensor = (category, type, unit, max, keepHistory = true) => ({
  category,
  type,
  min: 0,
  max,
  ...(unit ? { unit } : {}),
  read_only: true,
  has_feedback: false,
  keep_history: keepHistory,
});

/** The features of a water timer: `[{ key, spec, name }]`, in a stable order. */
export function timerFeatures(timer) {
  const features = [
    { key: 'watering', spec: binary(), name: FEATURE_NAMES.watering },
    {
      key: 'remaining',
      spec: sensor(C.DURATION, T.DURATION.INTEGER, U.SECONDS, LIMITS.remainingSeconds, false),
      name: FEATURE_NAMES.remaining,
    },
  ];
  if (timer.flowMeter) {
    features.push(
      {
        key: 'flow',
        spec: sensor(C.WATER_VALVE, T.WATER_VALVE.FLOW, U.CUBIC_METER_PER_HOUR, 60),
        name: FEATURE_NAMES.flow,
      },
      {
        key: 'volume',
        spec: sensor(
          C.WATER_VALVE,
          T.WATER_VALVE.REAL_TIME_IRRIGATION_VOLUME,
          U.LITER,
          LIMITS.sessionLitres,
        ),
        name: FEATURE_NAMES.volume,
      },
    );
  }
  features.push(
    {
      key: 'battery',
      spec: sensor(C.BATTERY, T.BATTERY.INTEGER, U.PERCENT, 100),
      name: FEATURE_NAMES.battery,
    },
    {
      key: 'signal',
      spec: sensor(C.SIGNAL, T.SIGNAL.QUALITY, undefined, 100),
      name: FEATURE_NAMES.signal,
    },
    { key: 'rf_linked', spec: binary(), name: FEATURE_NAMES.rfLinked },
    { key: 'plan_paused', spec: binary(), name: FEATURE_NAMES.planPaused },
    ...ALERTS.map((alert) => ({
      key: `alert_${alert}`,
      spec: binary(),
      name: FEATURE_NAMES[alert],
    })),
    { key: 'start', spec: button(), name: FEATURE_NAMES.start },
    { key: 'stop', spec: button(), name: FEATURE_NAMES.stop },
    { key: 'pause_plan', spec: button(), name: FEATURE_NAMES.pausePlan },
  );
  return features;
}

export const timerIds = (gladys, timerId) => gladys.externalIds(EXTERNAL_ID_TYPE, timerId);

export function timerName(timer) {
  return (timer.name || `LinkTap ${timer.id.slice(-6)}`).slice(0, 100);
}

const featureOf = (ids, { key, spec, name }, language) => {
  const feature = {
    name: word(name, language).slice(0, 100),
    external_id: ids.feature(key),
    category: spec.category,
    type: spec.type,
    min: spec.min,
    max: spec.max,
    read_only: spec.read_only,
    has_feedback: spec.has_feedback,
    keep_history: spec.keep_history,
  };
  if (spec.unit) {
    feature.unit = spec.unit;
  }
  return feature;
};

/** The Gladys device of a water timer of a known gateway. */
export function buildTimerDevice(gladys, gateway, timer, { language }) {
  const ids = timerIds(gladys, timer.id);
  const params = [
    { name: 'GATEWAY_ID', value: gateway.id },
    { name: 'GATEWAY_ADDRESS', value: gateway.address ?? '' },
    { name: 'GATEWAY_FIRMWARE', value: gateway.version ?? '' },
  ].filter((param) => param.value !== '');
  return {
    name: timerName(timer),
    external_id: ids.device,
    features: timerFeatures(timer).map((f) => featureOf(ids, f, language)),
    params,
    should_poll: false,
  };
}

/**
 * featureId -> `{ state }` from a reading, only the values known: a missing
 * value is skipped, never 0, never NaN. A timer not linked to the gateway by
 * radio only publishes that: the other values the gateway holds are old.
 */
export function valuesOf(gladys, timer, reading) {
  const values = new Map();
  const ids = timerIds(gladys, timer.id);
  const number = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.set(ids.feature(key), { state: value });
    }
  };
  const flag = (key, value) => {
    if (typeof value === 'boolean') {
      number(key, value ? 1 : 0);
    }
  };
  flag('rf_linked', reading.rfLinked);
  if (reading.rfLinked === false) {
    return values;
  }
  flag('watering', reading.watering);
  number('remaining', reading.remaining);
  if (timer.flowMeter) {
    number('flow', reading.flow);
    number('volume', reading.volume);
  }
  number('battery', reading.battery);
  number('signal', reading.signal);
  flag('plan_paused', reading.paused);
  for (const alert of ALERTS) {
    flag(`alert_${alert}`, reading.alerts?.[alert]);
  }
  return values;
}
