// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { setImmediate } from 'timers';

// React's scheduler prefers setImmediate over the MessageChannel installed above. An open
// MessageChannel port keeps Jest workers alive after the tests finish.
Object.assign(global, { setImmediate });
