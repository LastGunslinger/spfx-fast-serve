const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const CopyPlugin = require("copy-webpack-plugin");
const certificateManager = require("@rushstack/debug-certificate-manager");
const certificateStore = new certificateManager.CertificateStore();
const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");
const del = require("del");
const webpackMerge = require("webpack-merge").merge;
const extend = require("./webpack.extend");
const packageJson = require("../package.json");
const hasESLint = !!packageJson.devDependencies["@typescript-eslint/parser"];
let RestProxy;
const settings = require("./config.json");
const rootFolder = path.resolve(__dirname, "../");

setDefaultServeSettings(settings);

const port = settings.cli.isLibraryComponent ? 4320 : 4321;
const host = "https://localhost:" + port;
if (settings.cli.useRestProxy) {
  RestProxy = require('sp-rest-proxy');
}

///
// Transforms define("<guid>", ...) to web part specific define("<web part id_version", ...)
// the same approach is used inside copyAssets SPFx build step
///
class DynamicLibraryPlugin {
  constructor(options) {
    this.opitons = options;
  }

  apply(compiler) {
    compiler.hooks.emit.tap("DynamicLibraryPlugin", compilation => {
      for (const assetId in this.opitons.modulesMap) {
        const moduleMap = this.opitons.modulesMap[assetId];

        if (compilation.assets[assetId]) {
          const rawValue = compilation.assets[assetId].children[0]._value;
          compilation.assets[assetId].children[0]._value = rawValue.replace(this.opitons.libraryName, moduleMap.id + "_" + moduleMap.version);
        }
      }
    });
  }
}

///
// Removes *.module.scss.ts on the first execution in order prevent conflicts with *.module.scss.d.ts
// generated by css-modules-typescript-loader
///
class ClearCssModuleDefinitionsPlugin {
  constructor(options) {
    this.options = options || {};
  }

  apply(compiler) {
    compiler.hooks.done.tap("FixStylesPlugin", stats => {
      if (!this.options.deleted) {

        setTimeout(() => {
          del.sync(["src/**/*.module.scss.ts"], { cwd: rootFolder });
        }, 3000);

        this.options.deleted = true;
      }
    });
  }
}

let baseConfig = {
  target: "web",
  mode: "development",
  devtool: "source-map",
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    modules: ["node_modules"]
  },
  context: rootFolder,
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        options: {
          transpileOnly: true,
          compilerOptions: {
            declarationMap: false
          }
        },
        exclude: /node_modules/
      },
      {
        use: [{
          loader: "@microsoft/loader-cased-file",
          options: {
            name: "[name:lower]_[hash].[ext]"
          }
        }],
        test: /\.(jpe?g|png|woff|eot|ttf|svg|gif|dds)$/i
      },
      {
        use: [{
          loader: "html-loader"
        }],
        test: /\.html$/
      },
      {
        test: /\.css$/,
        use: [
          {
            loader: "@microsoft/loader-load-themed-styles",
            options: {
              async: true
            }
          },
          {
            loader: "css-loader",
            options: {
              esModule: false
            }
          }
        ]
      },
      {
        test: function (fileName) {
          return fileName.endsWith(".module.scss");   // scss modules support
        },
        use: [
          {
            loader: "@microsoft/loader-load-themed-styles",
            options: {
              async: true
            }
          },
          "css-modules-typescript-loader",
          {
            loader: "css-loader",
            options: {
              esModule: false,
              modules: {
                localIdentName: "[local]_[hash:base64:8]"
              }
            }
          }, // translates CSS into CommonJS
          "sass-loader" // compiles Sass to CSS, using Sass by default
        ]
      },
      {
        test: function (fileName) {
          return !fileName.endsWith(".module.scss") && fileName.endsWith(".scss");  // just regular .scss
        },
        use: [
          {
            loader: "@microsoft/loader-load-themed-styles",
            options: {
              async: true
            }
          },
          {
            loader: "css-loader",
            options: {
              esModule: false
            }
          }, // translates CSS into CommonJS
          "sass-loader" // compiles Sass to CSS, using Sass by default
        ]
      }
    ]
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({
      eslint: hasESLint ? {
        files: './src/**/*.{ts,tsx}',
        enabled: true
      } : undefined,
      async: true
    }),
    new ClearCssModuleDefinitionsPlugin(),
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
      "process.env.DEBUG": JSON.stringify(true),
      "DEBUG": JSON.stringify(true)
    })],
  devServer: {
    hot: false,
    contentBase: rootFolder,
    publicPath: host + "/dist/",
    host: "localhost",
    port: port,
    disableHostCheck: true,
    historyApiFallback: true,
    open: settings.serve.open,
    writeToDisk: settings.cli.isLibraryComponent,
    openPage: settings.serve.openUrl ? settings.serve.openUrl : host + "/temp/workbench.html",
    overlay: settings.serve.fullScreenErrors,
    stats: getLoggingLevel(settings.serve.loggingLevel),
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    https: {
      cert: certificateStore.certificateData,
      key: certificateStore.keyData
    }
  },
}

if (settings.cli.useRestProxy) {
  baseConfig.devServer.before = function (app) {
    new RestProxy({
      port,
      logLevel: "Off"
    }, app).serveProxy();
  }
}

const createConfig = function () {
  del.sync(["dist/*.js", "dist/*.map"], { cwd: rootFolder });

  // we need only "externals", "output" and "entry" from the original webpack config
  let originalWebpackConfig = require("../temp/_webpack_config.json");
  baseConfig.externals = originalWebpackConfig.externals;
  baseConfig.output = originalWebpackConfig.output;

  baseConfig.entry = getEntryPoints(originalWebpackConfig.entry);

  baseConfig.output.publicPath = host + "/dist/";

  const manifest = require("../temp/manifests.json");
  const config = require("../config/config.json");
  let localizedResources = config.localizedResources;
  const modulesMap = {};
  const localizedPathMap = {};
  const originalEntries = Object.keys(originalWebpackConfig.entry);

  for (const jsModule of manifest) {
    if (jsModule.loaderConfig
      && jsModule.loaderConfig.entryModuleId
      && originalEntries.indexOf(jsModule.loaderConfig.entryModuleId) !== -1) {
      const entryModuleId = jsModule.loaderConfig.entryModuleId;
      modulesMap[entryModuleId + ".js"] = {
        id: jsModule.id,
        version: jsModule.version,
        path: jsModule.loaderConfig.scriptResources[entryModuleId].path
      }

      extractLocalizedPaths(jsModule.loaderConfig.scriptResources, localizedPathMap, localizedResources);
    }
  }

  baseConfig.output.filename = function (pathInfo) {
    const entryPointName = pathInfo.chunk.name + ".js";
    return modulesMap[entryPointName].path;
  };

  baseConfig.plugins.push(new DynamicLibraryPlugin({
    modulesMap: modulesMap,
    libraryName: originalWebpackConfig.output.library
  }));

  baseConfig.devServer.proxy = [{
    target: host,
    secure: false,
    context: createProxyContext(localizedPathMap),
    pathRewrite: pathRewrite(localizedPathMap)
  }];

  if (settings.cli.isLibraryComponent) {
    addCopyPlugin(localizedResources);
  }

  return baseConfig;
}

function addCopyPlugin(localizedResources) {
  const patterns = [];
  for (const resourceKey in localizedResources) {
    const resourcePath = localizedResources[resourceKey];
    const from = resourcePath.replace(/^lib/gi, "src").replace("{locale}", "*");
    patterns.push({
      flatten: true,
      from,
      to: function (data) {
        const fileName = path.basename(data.absoluteFilename);
        return resourceKey + "_" + fileName;
      }
    });
  }

  baseConfig.plugins.push(new CopyPlugin({
    patterns
  }));
}

function extractLocalizedPaths(scriptResources, localizedPathMap, localizedResources) {
  const resourceKeys = Object.keys(localizedResources);

  for (const resourceKey of resourceKeys) {
    if (!scriptResources[resourceKey]) {
      continue;
    }

    const resource = scriptResources[resourceKey];
    if (resource.path) {
      const jsPath = resource.path;
      const fileNameWithoutExt = path.basename(jsPath, ".js");
      const underscoreIndex = fileNameWithoutExt.lastIndexOf("_");
      const localeCode = fileNameWithoutExt.substr(underscoreIndex + 1);
      localizedPathMap[jsPath] = {
        locale: localeCode.toLowerCase(),
        mapPath: localizedResources[resourceKey].replace(/^lib/gi, "src").replace("{locale}", localeCode.toLowerCase()) // src/webparts/helloWorld/loc/{locale}.js
      };
    }

    if (resource.paths) {
      for (const localeCode in resource.paths) {
        const jsPath = resource.paths[localeCode];
        localizedPathMap[jsPath] = {
          locale: localeCode.toLowerCase(),
          mapPath: localizedResources[resourceKey].replace(/^lib/gi, "src").replace("{locale}", localeCode.toLowerCase()) // src/webparts/helloWorld/loc/{locale}.js
        };
      }
    }
  }
}

function pathRewrite(localizedPathMap) {
  return function (requestPath) {
    const fileName = path.basename(requestPath);

    // we should rewrite localized resource path
    if (localizedPathMap[fileName]) {
      const resource = localizedPathMap[fileName];
      return "/" + resource.mapPath;
    }

    return requestPath;
  }
}

// rewrite only .js files - all localization files
function createProxyContext(localizedPathMap) {
  return function (requestPath) {
    const fileName = path.basename(requestPath);

    // if localized resource - HelloWorldWebPartStrings_en-us_<guid>.js - rewrite
    if (localizedPathMap[fileName]) {
      return true;
    }

    return false;
  }
}

function getEntryPoints(entry) {
  // fix: ".js" entry needs to be ".ts"
  // also replaces the path form /lib/* to /src/*
  // spfx not always follows path.sep settings, so just replace both variants
  let newEntry = {};
  let libSearchRegexp1 = /\/lib\//gi;
  let libSearchRegexp2 = /\\lib\\/gi;

  const srcPathToReplace1 = "/src/";
  const srcPathToReplace2 = "\\src\\";

  for (const key in entry) {
    let entryPath = entry[key];
    if (entryPath.indexOf("bundle-entries") === -1) {
      entryPath = entryPath
        .replace(libSearchRegexp1, srcPathToReplace1)
        .replace(libSearchRegexp2, srcPathToReplace2)
        .slice(0, -3) + ".ts";
    } else {
      // replace paths and extensions in bundle file
      let bundleContent = fs.readFileSync(entryPath).toString();
      bundleContent = bundleContent
        .replace(libSearchRegexp1, srcPathToReplace1)
        .replace(libSearchRegexp2, srcPathToReplace2)
        .replace(/\.js/gi, ".ts");
      fs.writeFileSync(entryPath, bundleContent);
    }
    newEntry[key] = entryPath;
  }

  return newEntry;
}

function getLoggingLevel(level) {
  if (level === "minimal") {
    return {
      all: false,
      colors: true,
      errors: true
    }
  }

  if (level === "normal") {
    return {
      all: false,
      colors: true,
      errors: true,
      timings: true,
      entrypoints: true
    }
  }

  if (level === "detailed") {
    return {
      all: false,
      colors: true,
      errors: true,
      timings: true,
      assets: true,
      warnings: true
    }
  }

  throw new Error("Unsupported log level: " + level);
}

function setDefaultServeSettings(settings) {
  const defaultServeSettings = {
    open: true,
    fullScreenErrors: true,
    loggingLevel: 'normal'
  }
  settings.serve = settings.serve || {};

  settings.serve = Object.assign(defaultServeSettings, settings.serve);

  if (settings.cli.isLibraryComponent) {
    settings.serve.open = false;
  }
}

module.exports = webpackMerge(extend.transformConfig(createConfig()), extend.webpackConfig);
