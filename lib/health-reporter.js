/*
 * Copyright 2024 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const defaultLogger = require('./logger').child({ component: 'HealthReporter' })

const VALID_CODES = new Map([
  ['NR-APM-000', 'Healthy.'],
  ['NR-APM-001', 'Invalid license key.'],
  ['NR-APM-002', 'License key missing.'],
  ['NR-APM-003', 'Forced disconnect received from New Relic.'],
  ['NR-APM-004', 'HTTP error communicating with New Relic.'],
  ['NR-APM-005', 'Missing application name in agent configuration.'],
  ['NR-APM-006', 'The maximum number of configured app names is exceeded.'],
  ['NR-APM-007', 'HTTP proxy is misconfigured.'],
  ['NR-APM-008', 'Agent is disabled via configuration.'],
  ['NR-APM-009', 'Failed to connect to the New Relic data collector.'],
  ['NR-APM-010', 'Agent config could not be parsed.'],
  ['NR-APM-099', 'Agent has shutdown.']
])

function writeStatus({ file, healthy = true, code, msg, startTime, callback } = {}) {
  const currentTime = Number(process.hrtime.bigint())
  const yaml = [
    `healthy: ${healthy}`,
    `status: '${msg}'`,
    `last_error: ${code}`,
    `start_time_unix_nano: ${startTime}`,
    `status_time_unix_nano: ${currentTime}`
  ].join('\n')
  fs.writeFile(file, yaml, { encoding: 'utf8' }, callback)
}

class HealthReporter {
  #status = HealthReporter.STATUS_HEALTHY
  #interval
  #destFile
  #logger
  #startTime

  static STATUS_HEALTHY = 'NR-APM-000'
  static STATUS_INVALID_LICENSE_KEY = 'NR-APM-001'
  static STATUS_LICENSE_KEY_MISSING = 'NR-APM-002'
  static STATUS_FORCED_DISCONNECT = 'NR-APM-003'
  static STATUS_BACKEND_ERROR = 'NR-APM-004'
  static STATUS_MISSING_APP_NAME = 'NR-APM-005'
  static STATUS_MAXIMUM_APP_NAMES_EXCEEDED = 'NR-APM-006'
  static STATUS_HTTP_PROXY_MISCONFIGURED = 'NR-APM-007'
  static STATUS_AGENT_DISABLED = 'NR-APM-008'
  static STATUS_CONNECT_ERROR = 'NR-APM-009'
  static STATUS_CONFIG_PARSE_FAILURE = 'NR-APM-010'
  static STATUS_AGENT_SHUTDOWN = 'NR-APM-099'

  constructor({ logger = defaultLogger, setInterval = global.setInterval } = {}) {
    const fleetId = process.env.NEW_RELIC_SUPERAGENT_FLEET_ID
    const outDir = process.env.NEW_RELIC_SUPERAGENT_HEALTH_DELIVERY_LOCATION
    let checkInterval = process.env.NEW_RELIC_SUPERAGENT_HEALTH_FREQUENCY

    this.#logger = logger

    if (!fleetId) {
      this.#logger.info('new relic control not present, skipping health reporting')
      return
    }

    if (outDir === undefined) {
      this.#logger.error('health check output directory not provided, skipping health reporting')
      return
    }

    if (checkInterval === undefined) {
      this.#logger.debug('health check interval not available, using default 5 seconds')
      checkInterval = 5_000
    } else {
      checkInterval = parseInt(checkInterval, 10) * 1_000
    }

    this.#startTime = Number(process.hrtime.bigint())

    const uuid = crypto.randomUUID().replaceAll('-', '')
    this.#destFile = path.join(outDir, `health-${uuid}.yaml`)

    this.#logger.info(
      `new relic control is present, writing health on interval ${checkInterval} milliseconds to ${
        this.#destFile
      }`
    )
    this.#interval = setInterval(this.#healthCheck.bind(this), checkInterval)
    this.#interval.unref()

    this.#logger.info('health reporter initialized')
  }

  #healthCheck() {
    const healthy = this.#status === HealthReporter.STATUS_HEALTHY
    writeStatus({
      file: this.#destFile,
      healthy,
      startTime: this.#startTime,
      code: this.#status,
      msg: VALID_CODES.get(this.#status),
      callback: (error) => {
        if (error) {
          this.#logger.error(`error when writing out health status: ${error.message}`)
        }
      }
    })
  }

  setStatus(status) {
    if (VALID_CODES.has(status) === false) {
      // TODO: if we ever add codes in our reserved block (300-399), account for them here
      this.#logger.warn(`invalid health reporter status provided: ${status}`)
      return
    }

    if (
      status === HealthReporter.STATUS_AGENT_SHUTDOWN &&
      this.#status !== HealthReporter.STATUS_HEALTHY
    ) {
      this.#logger.info(
        `not setting shutdown health status due to current status code: ${this.#status}`
      )
      return
    }

    this.#status = status
  }

  stop() {
    clearInterval(this.#interval)

    const healthy = this.#status === HealthReporter.STATUS_HEALTHY
    let code = this.#status
    let msg = VALID_CODES.get(code)
    if (healthy === true) {
      // We only update the status on shutdown when the last known state is
      // the healthy state. Otherwise, we need to leave the current code in
      // place, and just update the report time.
      code = HealthReporter.STATUS_AGENT_SHUTDOWN
      msg = VALID_CODES.get(code)
    }

    writeStatus({
      file: this.#destFile,
      startTime: this.#startTime,
      healthy,
      code,
      msg,
      callback: (error) => {
        if (error) {
          this.#logger.error(
            `error when writing out health status during shutdown: ${error.message}`
          )
        }
      }
    })
  }
}

module.exports = HealthReporter