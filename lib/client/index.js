const primus = require('primus');
const request = require('request');
const socket = require('./socket');
const relay = require('../relay');
const logger = require('../log');
const version = require('../version');

module.exports = ({ port = null, config = {}, filters = {} }) => {
  logger.info({ version }, 'running in client mode');

  const identifyingMetadata = {
    version,
    filters,
  };

  const io = socket({
    token: config.brokerToken,
    url: config.brokerServerUrl,
    filters: filters.private,
    config,
    identifyingMetadata,
  });

  // start the local webserver to listen for relay requests
  const { app, server } = require('../webserver')(config, port);

  // IMPORTANT: defined before relay (`app.all('/*', ...`)
  app.get(config.brokerHealthcheckPath || '/healthcheck', (req, res) => {
    // healthcheck state depends on websocket connection status
    // value of primus.Spark.OPEN means the websocket connection is open
    const isConnOpen = (io.readyState === primus.Spark.OPEN);
    const status = isConnOpen ? 200 : 500;
    const data = {
      ok: isConnOpen,
      websocketConnectionOpen: isConnOpen,
      brokerServerUrl: io.url.href,
      version,
    };

    return res.status(status).json(data);
  });

  app.get(config.brokerSystemcheckPath || '/systemcheck', (req, res) => {
    // Systemcheck is the broker client's ability to assert the network 
    // reachability and some correctness of credentials for the service
    // being proxied by the broker client.

    const brokerClientValidationMethod =
      config.brokerClientValidationMethod || 'GET';
    const brokerClientValidationTimeoutMs =
      config.brokerClientValidationTimeoutMs || 5000;

    const data = {
      brokerClientValidationUrl: logger.sanitise(config.brokerClientValidationUrl),
      brokerClientValidationMethod,
      brokerClientValidationTimeoutMs,
    };

    const validationRequestHeaders = {
      'user-agent': 'Snyk Broker client ' + version,
    };

    // set auth header according to config
    if (config.brokerClientValidationAuthorizationHeader) {
      validationRequestHeaders.authorization = config.brokerClientValidationAuthorizationHeader;
    } else if (config.brokerClientValidationBasicAuth) {
      validationRequestHeaders.authorization =
        `Basic ${new Buffer(config.brokerClientValidationBasicAuth).toString('base64')}`;
    }

    // make the internal validation request
    request({
      url: config.brokerClientValidationUrl,
      headers: validationRequestHeaders,
      method: brokerClientValidationMethod,
      timeout: brokerClientValidationTimeoutMs,
      json: true,
    }, (error, response) => {
      // test logic requires to surface internal data
      // which is best not exposed in production
      if (process.env.TAP) {
        data.testError = error;
        data.testResponse = response;
      }

      if (error) {
        data.ok = false;
        data.error = error.message;
        return res.status(500).json(data);
      }

      data.brokerClientValidationUrlStatusCode = response && response.statusCode;
      // check for 2xx status code
      const goodStatusCode = /^2/.test(response && response.statusCode);
      if (!goodStatusCode) {
        data.ok = false;
        data.error = 'Status code is not 2xx';
        return res.status(500).json(data);
      }

      data.ok = true;
      return res.status(200).json(data);
    });
  });
  
  // relay all other URL paths
  app.all('/*', (req, res, next) => {
    res.locals.io = io;
    next();
  }, relay.request(filters.public));

  return {
    io,
    close: done => {
      logger.info('client websocket is closing');
      server.close();
      io.destroy(function () {
        logger.info('client websocket is closed');
        if (done) {
          return done();
        }
      });
    },
  };
};
