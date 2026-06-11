import crypto from 'crypto';
import {
    EXCHANGE_API_SECRET
} from './config.js';

export function signPayload(payloadString: string) {
  return crypto
    .createHmac('sha256', EXCHANGE_API_SECRET)
    .update(payloadString, 'utf8')
    .digest('hex');
}