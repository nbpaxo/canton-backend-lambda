/**
 * Alert core — decoupled ops alerting.
 *
 *   sources ──registerAlert()──►  alerts table  ──runAlertProcessor()──► Telegram
 *
 * Sources (withdraw path, deposit watcher, health monitor) only ever call
 * registerAlert() / resolveAlert(). An always-on process (the deposit watcher)
 * calls runAlertProcessor() on each tick to deliver. The Lambda API never sends.
 */
export { registerAlert, resolveAlert } from './register.js';
export { runAlertProcessor } from './processor.js';
export { sendAlertToTelegram } from './telegram.js';
export type {
  AlertType,
  AlertSeverity,
  RegisterAlertInput,
  RegisterResult,
  ResolveAlertInput,
} from './types.js';
