const enabled = process.env.WORKER_ENABLED === 'true';
if (enabled) throw new Error('worker test must default to disabled');
const interval = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
if (!Number.isInteger(interval) || interval <= 0) throw new Error('worker interval must be positive');
