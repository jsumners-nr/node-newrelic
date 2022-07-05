/*
 * Copyright 2022 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const tap = require('tap')
const helper = require('../../lib/agent_helper')
const { ERR_CODE, ERR_MSG } = require('./constants')

const {
  assertExternalSegment,
  assertMetricsNotExisting,
  makeServerStreamingRequest,
  createServer,
  getClient
} = require('./util')

tap.test('gRPC Client: Server Streaming', (t) => {
  t.autoend()

  let agent
  let client
  let server
  let proto
  let grpc

  t.beforeEach(async () => {
    agent = helper.instrumentMockedAgent()
    grpc = require('@grpc/grpc-js')
    const data = await createServer(grpc)
    proto = data.proto
    server = data.server
    client = getClient(grpc, proto)
  })

  t.afterEach(() => {
    helper.unloadAgent(agent)
    server.forceShutdown()
    client.close()
    grpc = null
    proto = null
  })

  t.test('should track server streaming requests as an external when in a transaction', (t) => {
    helper.runInTransaction(agent, 'web', async (tx) => {
      agent.on('transactionFinished', (transaction) => {
        assertExternalSegment({ t, tx: transaction, fnName: 'SayHelloServerStream' })
        t.end()
      })

      const names = ['Bob', 'Jordi', 'Corey']
      const responses = await makeServerStreamingRequest({
        client,
        fnName: 'sayHelloServerStream',
        payload: { name: names }
      })
      names.forEach((name, i) => {
        t.equal(responses[i], `Hello ${name}`, 'response stream message should be correct')
      })
      tx.end()
    })
  })

  t.test('should include distributed trace headers when enabled', (t) => {
    helper.runInTransaction(agent, 'dt-test', async (tx) => {
      const payload = { name: ['dt test', 'dt test 2'] }
      await makeServerStreamingRequest({ client, fnName: 'sayHelloServerStream', payload })
      payload.name.forEach((name) => {
        const dtMeta = server.metadataMap.get(name)
        t.match(
          dtMeta.get('traceparent')[0],
          /^[\w\d\-]{55}$/,
          'should have traceparent in server metadata'
        )
        t.equal(dtMeta.get('newrelic')[0], '', 'should have newrelic in server metadata')
      })
      tx.end()
      t.end()
    })
  })

  t.test('should not include distributed trace headers when not in transaction', async (t) => {
    const payload = { name: ['dt not in transaction'] }
    await makeServerStreamingRequest({ client, fnName: 'sayHelloServerStream', payload })
    const dtMeta = server.metadataMap.get(payload.name[0])
    t.notOk(dtMeta.has('traceparent'), 'should not have traceparent in server metadata')
    t.notOk(dtMeta.has('newrelic'), 'should not have newrelic in server metadata')
  })

  t.test(
    'should not include distributed trace headers when distributed_tracing.enabled is set to false',
    (t) => {
      agent.config.distributed_tracing.enabled = false
      helper.runInTransaction(agent, 'dt-test', async (tx) => {
        const payload = { name: ['dt not in transaction'] }
        await makeServerStreamingRequest({ client, fnName: 'sayHelloServerStream', payload })
        const dtMeta = server.metadataMap.get(payload.name[0])
        t.notOk(dtMeta.has('traceparent'), 'should not have traceparent in server metadata')
        t.notOk(dtMeta.has('newrelic'), 'should not have newrelic in server metadata')
        tx.end()
        t.end()
      })
    }
  )

  t.test('should not track server streaming requests outside of a transaction', async (t) => {
    const payload = { name: ['New Relic'] }
    const responses = await makeServerStreamingRequest({
      client,
      fnName: 'sayHelloServerStream',
      payload
    })
    t.ok(responses.length, 1)
    t.equal(responses[0], 'Hello New Relic', 'response message is correct')
    assertMetricsNotExisting({ t, agent })
    t.end()
  })

  t.test('should record errors in a transaction', (t) => {
    const expectedStatusText = ERR_MSG
    const expectedStatusCode = ERR_CODE
    helper.runInTransaction(agent, 'web', async (tx) => {
      agent.on('transactionFinished', (transaction) => {
        t.equal(agent.errors.traceAggregator.errors.length, 1, 'should record a single error')
        const error = agent.errors.traceAggregator.errors[0][2]
        t.equal(error, expectedStatusText, 'should have the error message')
        assertExternalSegment({
          t,
          tx: transaction,
          fnName: 'SayErrorServerStream',
          expectedStatusText,
          expectedStatusCode
        })
        t.end()
      })

      try {
        const payload = { name: ['noes'] }
        await makeServerStreamingRequest({ client, fnName: 'sayErrorServerStream', payload })
      } catch (err) {
        t.ok(err, 'should get an error')
        t.equal(err.code, expectedStatusCode, 'should get the right status code')
        t.equal(err.details, expectedStatusText, 'should get the correct error message')
        tx.end()
      }
    })
  })
})
