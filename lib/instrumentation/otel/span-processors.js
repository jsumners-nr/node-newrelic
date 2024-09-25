/*
 * Copyright 2024 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

/**
 * @see https://open-telemetry.github.io/opentelemetry-js/interfaces/_opentelemetry_sdk_trace_base.SpanProcessor.html
 */
class NoopSpanProcessor {
  async forceFlush() {}
  onStart() {}
  onEnd() {}
  async shutdown() {}
}

class MultiSpanProcessor {
  #processors = []

  constructor(processors) {
    for (const p of processors) {
      this.#processors.push(p)
    }
  }

  forceFlush() {
    return Promise.all(this.#processors.map((p) => p.forceFlush()))
  }

  onStart(span, context) {
    for (const p of this.#processors) {
      p.onStart(span, context)
    }
  }

  onEnd(span) {
    for (const p of this.#processors) {
      p.onEnd(span)
    }
  }

  shutdown() {
    return Promise.all(this.#processors.map((p) => p.shutdown()))
  }
}

module.exports = { NoopSpanProcessor, MultiSpanProcessor }
