/*
 * Copyright 2024 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

process.env.NEW_RELIC_FEATURE_FLAG_OTEL_SDK = true

// const test = require('node:test')
const assert = require('node:assert')

const helper = require('../../lib/agent_helper')

const agent = helper.instrumentMockedAgent()
const otel = require('@opentelemetry/sdk-trace-node')
const provider = new otel.NodeTracerProvider()
