/*
 * Copyright 2024 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

// const { ClassWrapSpec, WrapSpec } = require('../../shim/specs')

module.exports = function instrumentOtel(shim, OtelTracerProvider) {
  const { agent } = shim
  if (agent.config.feature_flag.otel_sdk === false) {
    shim.logger.debug('`config.feature_flag.otel_sdk is false, skipping instrumentation of otel`')
    return
  }

  shim.wrapExport(OtelTracerProvider, () => {
    return new Proxy(OtelTracerProvider, {
      get(target, prop) {
        if (prop === 'NodeTracerProvider') {
          return function () {
            console.log('patched')
          }
        }
        return target[prop]
      }
    })
  })
}
