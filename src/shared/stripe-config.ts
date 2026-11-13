import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import Stripe from 'stripe';

export type Interval = 'month' | 'year';
export type Currency = 'USD' | 'INR';

const ssm = new SSMClient({});
const TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { value: string | null; at: number }>();
let client: Stripe | undefined;
let clientKey: string | undefined;
let override: Stripe | undefined;

/** Reads an SSM parameter (decrypted); a missing parameter is `null`. Cached for 15 minutes. */
export async function readParam(name: string): Promise<string | null> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    value = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? null;
  } catch (err: any) {
    if (err.name !== 'ParameterNotFound') throw err;
  }
  cache.set(name, { value, at: Date.now() });
  return value;
}

export function clearParamCache(): void {
  cache.clear();
  client = undefined;
  clientKey = undefined;
  override = undefined;
}

/** Test seam. */
export function setStripeClient(c: Stripe | undefined): void {
  override = c;
}

/** The Stripe client for the current secret key (rebuilt when the cached parameter rotates). Timeouts stay under CloudFront's 60 s origin timeout. */
export async function getStripe(): Promise<Stripe> {
  if (override) return override;
  const key = await readParam(process.env.STRIPE_SECRET_KEY_PARAM!);
  if (!key) throw new Error('Stripe secret key not found in SSM');
  if (!client || clientKey !== key) {
    client = new Stripe(key, { timeout: 20_000, maxNetworkRetries: 2 });
    clientKey = key;
  }
  return client;
}

const stage = () => process.env.STAGE_NAME || 'dev';

/** INR for viewers CloudFront geolocates to India, USD otherwise. */
export function billingCurrencyFor(country: string | undefined): Currency {
  return country?.toUpperCase() === 'IN' ? 'INR' : 'USD';
}

/** Pro price id for the interval and currency, from `/tradequt/<env>/stripe/price/pro_<interval>_<currency>`. */
export function proPriceId(interval: Interval, currency: Currency): Promise<string | null> {
  return readParam(`/tradequt/${stage()}/stripe/price/pro_${interval}_${currency.toLowerCase()}`);
}

/** The configured Pro price ids (monthly and yearly) of one currency. */
export async function proPriceIdsFor(currency: Currency): Promise<string[]> {
  const ids = await Promise.all((['month', 'year'] as Interval[]).map((i) => proPriceId(i, currency)));
  return ids.filter((id): id is string => !!id);
}

/** Every configured Pro price id. */
export async function allProPriceIds(): Promise<string[]> {
  const ids = await Promise.all(
    (['month', 'year'] as Interval[]).flatMap((i) => (['USD', 'INR'] as Currency[]).map((c) => proPriceId(i, c))),
  );
  return ids.filter((id): id is string => !!id);
}

export function portalConfigId(): Promise<string | null> {
  return readParam(`/tradequt/${stage()}/stripe/portalConfigId`);
}

const allowedOrigins = () => (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

/** The caller's origin when it is an allowed one, otherwise the stage's first allowed origin. */
export function checkoutOrigin(requestOrigin: string | undefined): string {
  const allowed = allowedOrigins();
  return requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : allowed[0] || 'https://tradequt.com';
}

/** True when the url starts with one of the allowed origins. */
export function isAllowedUrl(url: string): boolean {
  return allowedOrigins().some((o) => url === o || url.startsWith(`${o}/`));
}
