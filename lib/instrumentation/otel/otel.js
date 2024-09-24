/*
 * Copyright 2024 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const { ClassWrapSpec, WrapSpec } = require('../../shim/specs')

module.exports = function instrumentOtel(shim, OtelTracerProvider) {
  const { agent } = shim
  if (agent.config.feature_flag.otel_sdk === false) {
    shim.logger.debug('`config.feature_flag.otel_sdk is false, skipping instrumentation of otel`')
    return
  }

  // return new Proxy(OtelTracerProvider, {
  //   get(target, prop) {
  //     if (prop === 'NodeTracerProvider') {
  //       return function () {
  //         console.log('patched')
  //       }
  //     }
  //     return target[prop]
  //   }
  // })

  shim.wrapReturn(OtelTracerProvider, 'NodeTracerProvider', function () {
    console.log('patched')
  })

  // shim.wrapClass(
  //   OtelTracerProvider,
  //   'NodeTracerProvider',
  //   new ClassWrapSpec({
  //     pre(shim, toWrapClass, name, args) {
  //       console.log(`wrapping class ${name}:`, args)
  //     }
  //     // post: function nrConstructorWrapper(shim, wrappedClass, name, args) {
  //     //   this[kafkaCtx] = { brokers: args[0].brokers }
  //     //   shim.wrap(this, 'producer', instrumentProducer)
  //     //   shim.wrap(this, 'consumer', instrumentConsumer)
  //     // }
  //   })
  // )
}
