var webdriver = require('selenium-webdriver');
import {Logger} from './logger';
import * as q from 'q';
import {ConfigParser} from './configParser';

let logger = new Logger('plugins');

export enum PromiseType {
  Q,
  WEBDRIVER
}

export interface PluginConfig {
  path?: string;
  package?: string;
  inline?: ProtractorPlugin;
  name?: string;
  [key: string]: any;
}

export class ProtractorPlugin {
  skipAngularStability: boolean;

  name: string;
  config: PluginConfig;
  addFailure:
      (message?: string,
       info?: {specName?: string, stackTrace?: string}) => void;
  addSuccess: (info?: {specName?: string}) => void;
  addWarning: (message?: string, info?: {specName?: string}) => void;
}

/**
 * The plugin API for Protractor.  Note that this API is unstable. See
 * plugins/README.md for more information.
 *
 * @constructor
 * @param {Object} config parsed from the config file
 */
export class Plugins {
  pluginObjs: ProtractorPlugin[];
  assertions: {[key: string]: any[]};
  resultsReported: boolean;

  constructor(config: any) {
    this.pluginObjs = [];
    this.assertions = {};
    this.resultsReported = false;
    var pluginConfs: PluginConfig[] = config.plugins || [];
    pluginConfs.forEach((pluginConf: PluginConfig, i: number) => {
      var path: string;
      if (pluginConf.path) {
        path = ConfigParser.resolveFilePatterns(
            pluginConf.path, true, config.configDir)[0];
        if (!path) {
          throw new Error('Invalid path to plugin: ' + pluginConf.path);
        }
      } else {
        path = pluginConf.package;
      }

      var pluginObj: ProtractorPlugin;
      if (path) {
        pluginObj = (<ProtractorPlugin>require(path));
      } else if (pluginConf.inline) {
        pluginObj = pluginConf.inline;
      } else {
        throw new Error(
            'Plugin configuration did not contain a valid path or ' +
            'inline definition.');
      }

      this.annotatePluginObj(pluginObj, pluginConf, i);

      logger.debug('Plugin "' + pluginObj.name + '" loaded.');
      this.pluginObjs.push(pluginObj);
    });
  };

  /**
   * Adds properties to a plugin's object
   *
   * @see docs/plugins.md#provided-properties-and-functions
   */
  private annotatePluginObj(
      obj: ProtractorPlugin, conf: PluginConfig, i: number): void {
    let addAssertion =
        (info: {specName?: string, stackTrace?: string}, passed: boolean,
         message?: string) => {
          if (this.resultsReported) {
            throw new Error(
                'Cannot add new tests results, since they were already ' +
                'reported.');
          }
          info = info || {};
          var specName = info.specName || (obj.name + ' Plugin Tests');
          var assertion: any = {passed: passed};
          if (!passed) {
            assertion.errorMsg = message;
            if (info.stackTrace) {
              assertion.stackTrace = info.stackTrace;
            }
          }
          this.assertions[specName] = this.assertions[specName] || [];
          this.assertions[specName].push(assertion);
        };

    obj.name =
        obj.name || conf.name || conf.path || conf.package || ('Plugin #' + i);
    obj.config = conf;
    obj.addFailure =
        (message?, info?) => { addAssertion(info, false, message); };
    obj.addSuccess = (options?) => { addAssertion(options, true); };
    obj.addWarning = (message?, options?) => {
      options = options || {};
      logger.warn(
          'Warning ' + (options.specName ? 'in ' + options.specName :
                                           'from "' + obj.name + '" plugin') +
          ': ' + message);
    };
  }

  private printPluginResults(specResults: any) {
    var green = '\x1b[32m';
    var red = '\x1b[31m';
    var normalColor = '\x1b[39m';

    var printResult = (message: string, pass: boolean) => {
      logger.info(
          pass ? green : red, '\t', pass ? 'Pass: ' : 'Fail: ', message,
          normalColor);
    };

    for (var j = 0; j < specResults.length; j++) {
      var specResult = specResults[j];
      var passed = specResult.assertions.map((x: any) => { return x.passed; })
                       .reduce((x: any, y: any) => { return x && y; }, true);

      printResult(specResult.description, passed);
      if (!passed) {
        for (var k = 0; k < specResult.assertions.length; k++) {
          var assertion = specResult.assertions[k];
          if (!assertion.passed) {
            logger.error('\t\t' + assertion.errorMsg);
            if (assertion.stackTrace) {
              logger.error(
                  '\t\t' + assertion.stackTrace.replace(/\n/g, '\n\t\t'));
            }
          }
        }
      }
    }
  }

  /**
   * Gets the tests results generated by any plugins
   *
   * @see lib/frameworks/README.md#requirements for a complete description of what
   *     the results object must look like
   *
   * @return {Object} The results object
   */
  getResults() {
    var results: {failedCount: number,
                  specResults: any[]} = {failedCount: 0, specResults: []};
    for (var specName in this.assertions) {
      results.specResults.push(
          {description: specName, assertions: this.assertions[specName]});
      results.failedCount +=
          this.assertions[specName]
              .filter((assertion: any) => { return !assertion.passed; })
              .length;
    }
    this.printPluginResults(results.specResults);
    this.resultsReported = true;
    return results;
  };

  /**
   * Returns true if any loaded plugin has skipAngularStability enabled.
   *
   * @return {boolean}
   */
  skipAngularStability() {
    var result =
        this.pluginObjs.reduce((skip: boolean, pluginObj: ProtractorPlugin) => {
          return pluginObj.skipAngularStability || skip;
        }, false);
    return result;
  };

  /**
   * @see docs/plugins.md#writing-plugins for information on these functions
   */
  setup: Function = pluginFunFactory('setup', PromiseType.Q);
  teardown: Function = pluginFunFactory('teardown', PromiseType.Q);
  postResults: Function = pluginFunFactory('postResults', PromiseType.Q);
  postTest: Function = pluginFunFactory('postTest', PromiseType.Q);
  onPageLoad: Function = pluginFunFactory('onPageLoad', PromiseType.WEBDRIVER);
  onPageStable: Function =
      pluginFunFactory('onPageStable', PromiseType.WEBDRIVER);
  waitForPromise: Function =
      pluginFunFactory('waitForPromise', PromiseType.WEBDRIVER);
  waitForCondition: Function =
      pluginFunFactory('waitForCondition', PromiseType.WEBDRIVER, true);

  /**
   * Calls a function from a plugin safely.  If the plugin's function throws an
   * exception or returns a rejected promise, that failure will be logged as a
   * failed test result instead of crashing protractor.  If the tests results have
   * already been reported, the failure will be logged to the console.
   *
   * @param {Object} pluginObj The plugin object containing the function to be run
   * @param {string} funName The name of the function we want to run
   * @param {*[]} args The arguments we want to invoke the function with
   * @param {PromiseType} promiseType The type of promise (WebDriver or Q) that
   *    should be used
   * @param {boolean} resultsReported If the results have already been reported
   * @param {*} failReturnVal The value to return if the function fails
   *
   * @return {webdriver.promise.Promise|q.Promise} A promise which resolves to the
   *     function's return value
   */
  safeCallPluginFun(
      pluginObj: ProtractorPlugin, funName: string, args: IArguments,
      promiseType: PromiseType, failReturnVal: any): any {
    var deferred =
        promiseType == PromiseType.Q ? q.defer() : webdriver.promise.defer();
    var logError = (e: any) => {
      if (this.resultsReported) {
        this.printPluginResults([{
          description: pluginObj.name + ' Runtime',
          assertions: [{
            passed: false,
            errorMsg: 'Failure during ' + funName + ': ' + (e.message || e),
            stackTrace: e.stack
          }]
        }]);
      } else {
        pluginObj.addFailure(
            'Failure during ' + funName + ': ' + e.message || e,
            {stackTrace: e.stack});
      }
      deferred.fulfill(failReturnVal);
    };
    try {
      var result = (<any>pluginObj)[funName].apply(pluginObj, args);
      if (webdriver.promise.isPromise(result)) {
        result.then(
            function() { deferred.fulfill.apply(deferred, arguments); },
            (e: any) => { logError(e); });
      } else {
        deferred.fulfill(result);
      }
    } catch (e) {
      logError(e);
    }
    return deferred.promise;
  }
}

/**
 * Generates the handler for a plugin function (e.g. the setup() function)
 *
 * @param {string} funName The name of the function to make a handler for
 * @param {PromiseType} promiseType The type of promise (WebDriver or Q) that
 *    should be used
 * @param {boolean=} failReturnVal The value that the function should return if
 *     the plugin crashes
 *
 * @return {Function} The handler
 */
function pluginFunFactory(
    funName: string, promiseType: PromiseType,
    failReturnVal?: boolean): Function {
  return function() {
    var promises: any[] = [];
    var args = arguments;
    var self: Plugins = this;

    self.pluginObjs.forEach((pluginObj: ProtractorPlugin) => {
      if ((<any>pluginObj)[funName]) {
        promises.push(self.safeCallPluginFun(
            pluginObj, funName, args, promiseType, failReturnVal));
      }
    });

    if (promiseType == PromiseType.Q) {
      return q.all(promises);
    } else {
      return webdriver.promise.all(promises);
    }
  };
}
