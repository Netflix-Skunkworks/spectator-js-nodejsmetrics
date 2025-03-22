[![Snapshot](https://github.com/Netflix-Skunkworks/spectator-js-nodejsmetrics/actions/workflows/snapshot.yml/badge.svg)](https://github.com/Netflix-Skunkworks/spectator-js-nodejsmetrics/actions/workflows/snapshot.yml)

## spectator-js-nodemetrics

Library to gather runtime metrics for Node.js applications using [spectator-js].

See the [Atlas Documentation] site for more details on `spectator-js`.

[spectator-js]: https://github.com/Netflix/spectator-js
[Atlas Documentation]: https://netflix.github.io/atlas-docs/spectator/lang/nodejs/usage/

## Instrumenting Code

### CommonJS

```javascript
const spectator = require('nflx-spectator');
const NodeMetrics = require('nflx-spectator-nodejsmetrics');

const config = new spectator.Config();
const registry = new spectator.Registry(config);
const metrics = new NodeMetrics(registry);
metrics.start();

// application

metrics.stop();
```
