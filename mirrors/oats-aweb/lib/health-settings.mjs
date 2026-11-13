// Pure host-health settings validation shared by readiness and publishing.
import {CONTROL_CHARACTER} from './status-document.mjs';
import {booleanSetting} from './boolean-setting.mjs';

const OPERATOR_MAX_BYTES = 120;
const HEALTH_KEYS = ['publish', 'language', 'operator'];

/** settings.oats.aweb.health.publish through the shared boolean reader: false when absent;
 *  throws its refusal (fixed text only) for a value that is neither a boolean nor its string. */
export function healthPublish(settings) {
  const health = settings?.health;
  const value = health && typeof health === 'object' && !Array.isArray(health) ? health.publish : undefined;
  return booleanSetting(value, 'health.publish', false, 'set it under settings.oats.aweb.health in oats-local.yaml');
}

/** settings.oats.aweb.health, checked: publishing is off unless publish is true. */
export function healthSettings(settings) {
  const health = settings?.health ?? {};
  if (typeof health !== 'object' || Array.isArray(health)) throw new Error('settings.oats.aweb.health must be a map');
  const unknown = Object.keys(health).find((k) => !HEALTH_KEYS.includes(k));
  if (unknown !== undefined) throw new Error(`unknown health setting: ${unknown}`);
  const publish = healthPublish(settings);
  if (health.language !== undefined && (typeof health.language !== 'string' || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(health.language))) throw new Error('health.language must be a BCP 47 tag');
  if (health.operator !== undefined && (typeof health.operator !== 'string' || !health.operator || CONTROL_CHARACTER.test(health.operator) || Buffer.byteLength(health.operator) > OPERATOR_MAX_BYTES)) throw new Error(`health.operator must be one line of at most ${OPERATOR_MAX_BYTES} bytes`);
  return {publish, language: health.language ?? 'en', operator: health.operator ?? null};
}

