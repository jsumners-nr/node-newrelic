/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const dbutil = require('../db/utils')
const hasOwnProperty = require('../util/properties').hasOwn
const logger = require('../logger').child({ component: 'DatastoreShim' })
const metrics = require('../metrics/names')
const parseSql = require('../db/query-parsers/sql')
const ParsedStatement = require('../db/parsed-statement')
const Shim = require('./shim')
const urltils = require('../util/urltils')
const util = require('util')
const specs = require('./specs')
const recordOperationMetrics = require('../../lib/metrics/recorders/database-operation')
const { DatastoreParameters } = specs.params
const recordQueryMetrics = require('../../lib/metrics/recorders/database')

/**
 * An enumeration of well-known datastores so that new instrumentations can use
 * the same names we already use for first-party instrumentation.
 *
 * Each of these values is also exposed directly on the DatastoreShim class as
 * static members.
 *
 * @readonly
 * @memberof DatastoreShim
 * @enum {string}
 */
const DATASTORE_NAMES = {
  CASSANDRA: 'Cassandra',
  DYNAMODB: 'DynamoDB',
  ELASTICSEARCH: 'ElasticSearch',
  MEMCACHED: 'Memcache',
  MONGODB: 'MongoDB',
  MYSQL: 'MySQL',
  NEPTUNE: 'Neptune',
  OPENSEARCH: 'OpenSearch',
  POSTGRES: 'Postgres',
  REDIS: 'Redis',
  PRISMA: 'Prisma'
}

/**
 * Default value for unknown instance parameters.
 *
 * @readonly
 * @private
 */
const INSTANCE_UNKNOWN = 'unknown'

const defaultParsers = {
  SQL: parseSql
}

/**
 * Pre-defined query parsers for well-known languages.
 *
 * Each of these values is also exposed directly on the DatastoreShim class as
 * static members.
 *
 * @readonly
 * @memberof DatastoreShim
 * @enum {string}
 */
const QUERY_PARSERS = {
  SQL_PARSER: 'SQL'
}

/**
 * Constructs a shim associated with the given agent instance, specialized for
 * instrumenting datastores.
 *
 * @class
 * @augments Shim
 * @classdesc A helper class for wrapping datastore modules.
 * @param {Agent} agent The agent this shim will use.
 * @param {string} moduleName The name of the module being instrumented.
 * @param {string} resolvedName The full path to the loaded module.
 * @param {string} shimName Used to persist shim ids across different shim instances.
 * @param {string} pkgVersion version of module
 * @see Shim
 * @see DatastoreShim.DATASTORE_NAMES
 */
function DatastoreShim(agent, moduleName, resolvedName, shimName, pkgVersion) {
  Shim.call(this, agent, moduleName, resolvedName, shimName, pkgVersion)
  this._logger = logger.child({ module: moduleName })
  this.queryParser = defaultParsers[this.SQL_PARSER]
}
module.exports = DatastoreShim

util.inherits(DatastoreShim, Shim)

// Add constants on the shim for the well-known datastores.
DatastoreShim.DATASTORE_NAMES = DATASTORE_NAMES
Object.keys(DATASTORE_NAMES).forEach(function defineDatastoreMetricEnum(dsName) {
  Shim.defineProperty(DatastoreShim, dsName, DATASTORE_NAMES[dsName])
  Shim.defineProperty(DatastoreShim.prototype, dsName, DATASTORE_NAMES[dsName])
})

// Add constants on the shim for the provided query parsers.
DatastoreShim.QUERY_PARSERS = QUERY_PARSERS
Object.keys(QUERY_PARSERS).forEach(function defineQueryParserEnum(qpName) {
  Shim.defineProperty(DatastoreShim, qpName, QUERY_PARSERS[qpName])
  Shim.defineProperty(DatastoreShim.prototype, qpName, QUERY_PARSERS[qpName])
})

DatastoreShim.prototype.setDatastore = setDatastore
DatastoreShim.prototype.recordOperation = recordOperation
DatastoreShim.prototype.recordQuery = recordQuery
DatastoreShim.prototype.recordBatchQuery = recordBatchQuery
DatastoreShim.prototype.parseQuery = parseQuery
DatastoreShim.prototype.setParser = setParser
DatastoreShim.prototype.bindRowCallbackSegment = bindRowCallbackSegment
DatastoreShim.prototype.captureInstanceAttributes = captureInstanceAttributes
DatastoreShim.prototype.getDatabaseNameFromUseQuery = getDatabaseNameFromUseQuery

// -------------------------------------------------------------------------- //

/**
 * @callback QuerySpecFunction
 * @summary
 *  Used for determining information about a query when it can not be simply
 *  found in the arguments.
 * @param {Shim} shim
 *  The shim this function was passed to.
 * @param {Function} func
 *  The function being recorded.
 * @param {string} name
 *  The name of the function.
 * @param {Array.<*>} args
 *  The arguments being passed into the function.
 * @returns {QuerySpec} The spec for how this query should be recorded.
 * @see DatastoreShim#recordQuery
 * @see DatastoreShim#recordBatchQuery
 * @see QuerySpec
 */

/**
 * @callback QueryParserFunction
 * @summary
 *  Used to parse queries to extract the basic information about it.
 * @param {string} query - The query to be parsed.
 * @returns {ParsedQueryData} An object containing the basic information about
 *  the query.
 * @see DatastoreShim#setParser
 * @see ParsedQueryData
 */

/**
 * @interface ParsedQueryData
 * @description
 *  Returned by a {@link QueryParserFunction}, this information is used to
 *  generate the name for recording datastore queries.
 * @property {string} operation
 *  The datastore operation such as `SELECT` or `UPDATE`.
 * @property {string} collection
 *  The collection being queried. This would be the table name from a SQL
 *  statement or the collection name in a MongoDB query.
 * @property {string} [query]
 *  The query with any sensitive information redacted and comments removed.
 * @see DatastoreShim#setParser
 * @see QueryParserFunction
 */

// -------------------------------------------------------------------------- //

/**
 * Sets the vendor the module implements.
 *
 * This is used to determine the names for metrics and segments. If a string is
 * passed, metric names will be generated using that name.
 *
 * This method *MUST* be called to use any methods that generate
 * segments or metrics.
 *
 * @memberof DatastoreShim.prototype
 * @param {string} datastore
 *  The name of this datastore. Use one of the well-known constants listed in
 *  {@link DatastoreShim.DATASTORE_NAMES} if available for the datastore.
 * @see DatastoreShim.DATASTORE_NAMES
 * @see DatastoreShim#recordBatchQuery
 * @see DatastoreShim#recordQuery
 * @see DatastoreShim#recordOperation
 * @see DatastoreShim#parseQuery
 */
function setDatastore(datastore) {
  this._metrics = {
    PREFIX: datastore,
    STATEMENT: metrics.DB.STATEMENT + '/' + datastore + '/',
    OPERATION: metrics.DB.OPERATION + '/' + datastore + '/',
    INSTANCE: metrics.DB.INSTANCE + '/' + datastore + '/',
    ALL: metrics.DB.PREFIX + datastore + '/' + metrics.ALL
  }

  this._datastore = datastore

  this._logger = this._logger.child({ datastore: this._metrics.PREFIX })
  this.logger.trace({ metrics: this._metrics }, 'Datastore metric names set')
}

/**
 * Sets the query parser used by this shim instance.
 *
 * @memberof DatastoreShim.prototype
 * @param {string|QueryParserFunction} parser
 *  The string used to look up a default parser or the function used to parse
 *  queries. It is recommended that you use one of the well-known constants if
 *  available in the {@link DatastoreShim.QUERY_PARSERS}.
 * @see DatastoreShim.QUERY_PARSERS
 * @see QueryParserFunction
 * @see ParsedQueryData
 */
function setParser(parser) {
  if (this.isString(parser)) {
    const newParser = defaultParsers[parser]
    if (newParser) {
      this.queryParser = newParser
    } else {
      this.logger.debug(
        'Attempted to set the query parser to invalid parser %s, not setting new parser',
        parser
      )
    }
  } else if (this.isFunction(parser)) {
    this.queryParser = parser
  } else {
    this.logger.trace('Received invalid parser (%s)', parser)
  }
}

/**
 * Wraps the given properties as datastore operations that should be recorded.
 *
 * - `recordOperation(nodule, properties, opSpec)`
 * - `recordOperation(func, opSpec)`
 *
 * The resulting wrapped methods will record their actions using the datastore
 * `OPERATION` metric.
 *
 * NOTE: Calling this method before {@link DatastoreShim#setDatastore}
 * will result in an exception.
 *
 * @memberof DatastoreShim.prototype
 * @param {object | Function} nodule
 *  The source for the properties to wrap, or a single function to wrap.
 * @param {string|Array.<string>} [properties]
 *  One or more properties to wrap. If omitted, the `nodule` parameter is
 *  assumed to be the function to wrap.
 * @param {OperationSpec|SegmentFunction} opSpec
 *  The spec for this operation function.
 * @returns {object | Function} The first parameter to this function, after
 *  wrapping it or its properties.
 * @see Shim#wrap
 * @see Shim#record
 * @see OperationSpec
 * @see SegmentFunction
 */
function recordOperation(nodule, properties, opSpec) {
  if (this.isObject(properties) && !this.isArray(properties)) {
    // operation(func, opSpec)
    opSpec = properties
    properties = null
  }

  // TODO: not a fan of this. people should always pass in some sort of spec
  if (!opSpec) {
    opSpec = Object.create(null)
  }

  return this.record(nodule, properties, function operationRecorder(shim, fn, fnName, args) {
    shim.logger.trace('Recording datastore operation "%s"', fnName)

    const segDesc = _getSpec.call(this, {
      spec: opSpec,
      shim,
      fn,
      fnName,
      args
    })

    // Adjust the segment name with the metric prefix and add a recorder.
    if (!hasOwnProperty(segDesc, 'record') || segDesc.record !== false) {
      if (!segDesc?.name?.startsWith(shim._metrics.OPERATION)) {
        segDesc.name = shim._metrics.OPERATION + segDesc.name
      }
      segDesc.recorder = recordOperationMetrics.bind(shim)
    }

    return segDesc
  })
}

/**
 * Wraps the given properties as datastore query that should be recorded.
 *
 * - `recordQuery(nodule, properties, querySpec)`
 * - `recordQuery(func, querySpec)`
 *
 * The resulting wrapped methods will record their actions using the datastore
 * `STATEMENT` metric.
 *
 * NOTE: Calling this method before {@link DatastoreShim#setDatastore}
 * will result in an exception.
 *
 * @memberof DatastoreShim.prototype
 * @param {object | Function} nodule
 *  The source for the properties to wrap, or a single function to wrap.
 * @param {string|Array.<string>} [properties]
 *  One or more properties to wrap. If omitted, the `nodule` parameter is
 *  assumed to be the function to wrap.
 * @param {QuerySpec|QuerySpecFunction} querySpec
 *  The spec for this query function.
 * @returns {object | Function} The first parameter to this function, after
 *  wrapping it or its properties.
 * @see Shim#wrap
 * @see Shim#record
 * @see DatastoreShim#recordBatchQuery
 * @see QuerySpec
 * @see QuerySpecFunction
 */
function recordQuery(nodule, properties, querySpec) {
  return _recordQuery.call(this, '', nodule, properties, querySpec)
}

/**
 * Just like {@link DatastoreShim#recordQuery}, but with a `batch` suffix for
 * the recorded metric.
 *
 * - `recordBatchQuery(nodule, properties, querySpec)`
 * - `recordBatchQuery(func, querySpec)`
 *
 * The resulting wrapped methods will record their actions using the datastore
 * `STATEMENT` metric with a `/batch` suffix.
 *
 * NOTE: Calling this method before {@link DatastoreShim#setDatastore}
 * will result in an exception.
 *
 * @memberof DatastoreShim.prototype
 * @param {object | Function} nodule
 *  The source for the properties to wrap, or a single function to wrap.
 * @param {string|Array.<string>} [properties]
 *  One or more properties to wrap. If omitted, the `nodule` parameter is
 *  assumed to be the function to wrap.
 * @param {QuerySpec|QuerySpecFunction} querySpec
 *  The spec for this query function.
 * @returns {object | Function} The first parameter to this function, after
 *  wrapping it or its properties.
 * @see Shim#wrap
 * @see Shim#record
 * @see DatastoreShim#recordQuery
 * @see QuerySpec
 * @see QuerySpecFunction
 */
function recordBatchQuery(nodule, properties, querySpec) {
  return _recordQuery.call(this, '/batch', nodule, properties, querySpec)
}

/**
 * Parses the given query to extract information for any metrics that will be
 * created.
 *
 * NOTE: Calling this method before {@link DatastoreShim#setDatastore}
 * will result in an exception.
 *
 * @memberof DatastoreShim.prototype
 * @param {string} query - The query to parse.
 * @param {object} nodule - Context for the queryParse to run under.
 * @returns {ParsedStatement} The parsed query object.
 * @see DatastoreShim#setParser
 */
function parseQuery(query, nodule) {
  const parsed = this.queryParser.call(nodule, query)

  let collection = parsed.collection
  // strip enclosing special characters from collection (table) name
  if (typeof collection === 'string' && collection.length > 2) {
    if (/^[[{'"`]/.test(collection)) {
      collection = collection.substring(1)
    }
    if (/[\]}'"`]$/.test(collection)) {
      collection = collection.substring(0, collection.length - 1)
    }
  }

  const queryRecorded =
    this.agent.config.transaction_tracer.record_sql === 'raw' ||
    this.agent.config.transaction_tracer.record_sql === 'obfuscated'

  return new ParsedStatement(
    this._metrics.PREFIX,
    parsed.operation,
    collection,
    queryRecorded ? parsed.query : null
  )
}

/**
 * Wraps the callback in an arguments array with one that is bound to a segment.
 *
 * - `bindRowCallbackSegment(args, cbIdx [, parentSegment])`
 *
 * @memberof DatastoreShim.prototype
 * @param {Array} args
 *  The arguments array to replace the callback in.
 * @param {number} cbIdx
 *  The index of the callback in the arguments array.
 * @param {TraceSegment} [parentSegment]
 *  Optional. The segment to be the parent row callback's segment. Defaults to
 *  the segment active when the row callback is first called.
 */
function bindRowCallbackSegment(args, cbIdx, parentSegment) {
  const idx = this.normalizeIndex(args.length, cbIdx)
  if (idx === null) {
    this.logger.debug('Not binding row callback, invalid cbIdx %s', cbIdx)
    return
  }

  // Pull out the callback and make sure it is a function.
  const cb = args[idx]
  if (!this.isFunction(cb)) {
    this.logger.debug('Argument %d is not a function, not binding row callback', cbIdx)
    return cb
  }
  this.logger.trace('Wrapping argument %d as a row callback.', cbIdx)

  // We have a little state to maintain through potentially multiple calls.
  let callCounter = 0
  let segment = null
  const segmentName = 'Callback: ' + this.getName(cb)
  const shim = this

  const wrapper = this.bindSegment(function rowCallbackWrapper() {
    // The first time this row callback is fired we want to touch the parent
    // segment and create the callback segment.
    if (++callCounter === 1) {
      const realParent = parentSegment || shim.getSegment()
      realParent && realParent.touch()
      segment = shim.createSegment({ name: segmentName, parent: realParent })

      if (segment) {
        segment.async = false
      }
    }

    // Update the segment name and run the actual callback.
    if (segment) {
      segment.addAttribute('count', callCounter)
    }

    return shim.applySegment(cb, segment, true, this, arguments)
  }, parentSegment)

  shim.assignOriginal(wrapper, cb, true)
  args[idx] = wrapper
}

/**
 * Normalizes and adds datastore instance attributes to the current segment.
 *
 * If the current segment was not created by this shim then no action is taken.
 *
 * @memberof DatastoreShim.prototype
 * @param {string}        host      - The name of the database host.
 * @param {number|string} port      - The port, path, or ID of the database server.
 * @param {string}        database  - The name of the database in use.
 */
function captureInstanceAttributes(host, port, database) {
  // See if we are currently in a segment created by us.
  const segment = this.getSegment()
  if (!segment || segment.shimId !== this.id) {
    this.logger.trace(
      'Not adding db instance metric attributes to segment %j',
      segment && segment.name
    )
    return
  }
  this.logger.trace('Adding db instance attributes to segment %j', segment.name)

  // Normalize the instance attributes.
  const attributes = _normalizeParameters.call(
    this,
    new DatastoreParameters({
      host,
      port_path_or_id: port,
      database_name: database
    })
  )

  for (const key in attributes) {
    if (attributes[key]) {
      segment.addAttribute(key, attributes[key])
    }
  }
}

/**
 * Parses the database name from a `USE` SQL query.
 *
 * @memberof DatastoreShim.prototype
 * @param {string} query - The SQL query to parse the database name from.
 * @returns {?string} The name of the database if it could be parsed, otherwise
 *  `null`.
 */
function getDatabaseNameFromUseQuery(query) {
  return dbutil.extractDatabaseChangeFromUse(query)
}

// -------------------------------------------------------------------------- //

/**
 * Wraps the given properties as datastore query that should be recorded.
 *
 * - `_recordQuery(suffix, nodule, properties, querySpec)`
 * - `_recordQuery(suffix, func, querySpec)`
 *
 * The resulting wrapped methods will record their actions using the datastore
 * `STATEMENT` metric.
 *
 * @private
 * @this DatastoreShim
 * @param {string} suffix
 *  Suffix to be added to the segment name.
 * @param {object | Function} nodule
 *  The source for the properties to wrap, or a single function to wrap.
 * @param {string|Array.<string>} [properties]
 *  One or more properties to wrap. If omitted, the `nodule` parameter is
 *  assumed to be the function to wrap.
 * @param {QuerySpec|QueryFunction} querySpec
 *  The spec for this query function.
 * @returns {object | Function} The first parameter to this function, after
 *  wrapping it or its properties.
 * @see Shim#wrap
 * @see Shim#record
 * @see DatastoreShim#recordQuery
 * @see DatastoreShim#recordBatchQuery
 * @see QuerySpec
 * @see QuerySpecFunction
 */
function _recordQuery(suffix, nodule, properties, querySpec) {
  if (this.isObject(properties) && !this.isArray(properties)) {
    // _recordQuery(suffix, func, querySpec)
    querySpec = properties
    properties = null
  }

  if (!querySpec) {
    this.logger.debug('Missing query spec for recordQuery, not wrapping.')
    return nodule
  }

  return this.record(nodule, properties, function queryRecorder(shim, fn, fnName, args) {
    shim.logger.trace('Determining query information for %j', fnName)
    const segDesc = _getSpec.call(this, { spec: querySpec, shim, fn, fnName, args })

    // Adjust the segment name with the metric prefix and add a recorder.
    if (!hasOwnProperty(segDesc, 'record') || segDesc.record !== false) {
      // Fetch the query string.
      const queryStr = _extractQueryStr.call(shim, fn, fnName, segDesc, this, args)
      if (!shim.isString(queryStr)) {
        return null
      }

      // Parse the query and assemble the name.
      const parsed = shim.parseQuery(queryStr, this)
      const name = (parsed.collection || 'other') + '/' + parsed.operation + suffix
      shim.logger.trace('Found and parsed query %s -> %s', parsed.type, name)
      segDesc.name = shim._metrics.STATEMENT + name
      segDesc.recorder = recordQueryMetrics.bind(parsed)
    }

    return segDesc
  })
}

/**
 * Compiles spec by calling it if it is a function or cloning original.
 * This also defaults the name and normalizes the parameters.
 *
 * @private
 * @param {object} params to function
 * @param {QuerySpec|OperationSpec} params.spec spec for the given shim method
 * @param {DatastoreShim} params.shim instance of shim
 * @param {function} params.fn function being instrumented
 * @param {string} params.fnName name of function being instrumented
 * @param {Array} params.args arguments to function being instrumented
 * @returns {QuerySpec|OperationSpec} compiled spec
 *
 */
function _getSpec({ spec, shim, fn, fnName, args }) {
  let dsSpec = spec
  if (shim.isFunction(spec)) {
    dsSpec = spec.call(this, shim, fn, fnName, args)
  }

  dsSpec.parameters = _normalizeParameters.call(shim, dsSpec.parameters)
  return dsSpec
}

/**
 * Extracts the query string from the arguments according to the given spec.
 *
 * - `_extractQueryStr(fn, fnName, spec, ctx, args)`
 *
 * @private
 * @this DatastoreShim
 * @param {Function}  fn      - The query function to be executed.
 * @param {string}    fnName  - The name of the query function.
 * @param {QuerySpec} spec    - The query spec.
 * @param {*}         ctx     - The context of the query function's execution.
 * @param {Array}     args    - The arguments for the query function.
 * @returns {?string} The query from the arguments if found, otherwise `null`.
 */
function _extractQueryStr(fn, fnName, spec, ctx, args) {
  let queryStr = spec.query
  if (this.isNumber(queryStr)) {
    const queryIdx = this.normalizeIndex(args.length, queryStr)
    if (queryIdx === null) {
      this.logger.debug('Invalid query index %d of %d', queryStr, args.length)
      return null
    }
    queryStr = args[queryIdx]
  } else if (this.isFunction(queryStr)) {
    queryStr = queryStr.call(ctx, this, fn, fnName, args)
  }

  return queryStr
}

/**
 * Normalizes segment parameter values.
 *
 * - `_normalizeParameters([parameters])`
 *
 * Removes disabled parameters and corrects other values, such as changing host
 * from `localhost` to the actual host name.
 *
 * @private
 * @this DatastoreShim
 * @param {object} [parameters] - The segment parameters to clean up.
 * @returns {object} - The normalized segment parameters.
 */
function _normalizeParameters(parameters) {
  parameters = parameters || Object.create(null)
  const config = this.agent.config
  const dsTracerConf = config.datastore_tracer

  parameters.product = parameters.product || this._datastore

  _normalizeDatabaseName(parameters, dsTracerConf)
  _normalizeInstanceInformation(parameters, dsTracerConf, config)

  return parameters
}

/**
 * Normalizes the database name from segment parameter values.
 *
 * @private
 * @param {object} parameters   - The segment parameters to clean up.
 * @param {object} dsTracerConf - The datastore tracer configuration
 */
function _normalizeDatabaseName(parameters, dsTracerConf) {
  // Add database name if provided and enabled.
  if (!dsTracerConf.database_name_reporting.enabled) {
    delete parameters.database_name
  } else if (hasOwnProperty(parameters, 'database_name') && parameters.database_name !== false) {
    parameters.database_name =
      typeof parameters.database_name === 'number'
        ? String(parameters.database_name)
        : parameters.database_name || INSTANCE_UNKNOWN
  }
}

/**
 * Normalizes the database instance information from segment parameter
 * values: host and the port/path/id.
 *
 * @private
 * @param {object} parameters   - The segment parameters to clean up.
 * @param {object} dsTracerConf - The datastore tracer configuration
 * @param {object} config       - The agent configuration
 */
function _normalizeInstanceInformation(parameters, dsTracerConf, config) {
  // Add instance information if enabled.
  if (!dsTracerConf.instance_reporting.enabled) {
    delete parameters.host
    delete parameters.port_path_or_id
  } else {
    // Determine appropriate defaults for host and port.
    if (hasOwnProperty(parameters, 'port_path_or_id')) {
      parameters.port_path_or_id = String(parameters.port_path_or_id || INSTANCE_UNKNOWN)
    }
    if (hasOwnProperty(parameters, 'host')) {
      if (parameters.host && urltils.isLocalhost(parameters.host)) {
        parameters.host = config.getHostnameSafe()
      }

      // Config's default name of a host is `UNKNOWN_BOX`.
      if (!parameters.host || parameters.host === 'UNKNOWN_BOX') {
        parameters.host = INSTANCE_UNKNOWN
      }
    }
  }
}
