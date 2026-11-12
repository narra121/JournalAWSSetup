import { clearParamCache } from '../../shared/stripe-config';

export * from '../../shared/stripe-config';

/** Clears the parameter cache and the cached Stripe client (tests). */
export const clearBillingCache = clearParamCache;
