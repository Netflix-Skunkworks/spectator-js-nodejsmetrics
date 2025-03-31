[![Snapshot](https://github.com/Netflix-Skunkworks/spectator-js-nodejsmetrics/actions/workflows/snapshot.yml/badge.svg)](https://github.com/Netflix-Skunkworks/spectator-js-nodejsmetrics/actions/workflows/snapshot.yml)
[![npm version](https://badge.fury.io/js/nflx-spectator-nodejsmetrics.svg)](https://badge.fury.io/js/nflx-spectator-nodejsmetrics)

## spectator-js-nodejsmetrics

Library to gather runtime metrics for Node.js applications using [spectator-js].

See the [Atlas Documentation] site for more details on `spectator-js`.

[spectator-js]: https://github.com/Netflix/spectator-js
[Atlas Documentation]: https://netflix.github.io/atlas-docs/spectator/lang/nodejs/usage/

## Instrumenting Code

### CommonJS

```javascript
const spectator = require('nflx-spectator');
const config = new spectator.Config("udp", {"platform": "express-demo"});
const registry = new spectator.Registry(config);

const nodejsMetrics = require('nflx-spectator-nodejsmetrics');
const runtimeMetrics = new nodejsMetrics.RuntimeMetrics(registry);
runtimeMetrics.start();

// application

runtimeMetrics.stop();
```

## Module

```javascript
import {Config, Registry} from "nflx-spectator";
import {RuntimeMetrics} from "nflx-spectator-nodejsmetrics";

const config = new Config("udp", {"platform": "express-demo"});
const registry = new Registry(config);
const runtimeMetrics = new RuntimeMetrics(registry);

runtimeMetrics.start();

// application

runtimeMetrics.stop();
```
