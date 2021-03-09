/*
 * If not stated otherwise in this file or this component's LICENSE file the
 * following copyright and licenses apply:
 *
 * Copyright 2020 RDK Management
 *
 * Licensed under the Apache License, Version 2.0 (the License);
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  getConfigMap,
  isArray,
  isBoolean,
  isComponentConstructor,
  isFunction,
  isPage,
  symbols,
} from './helpers'
import { navigate, step } from '../index'
import { createRoute, getOption } from './route'
import { createComponent } from './components'
import Log from '../../Log'
import { isWildcard } from './regex'
import emit from './emit'
import { updateWidgets } from './widgets'
import { setHistory, updateHistory } from './history'
import { AppInstance } from '../../Application'

/**
 * @type {Lightning.Application}
 */
export let application

/**
 * Actual instance of the app
 * @type {Lightning.Component}
 */
export let app

/**
 * Component that hosts all routed pages
 * @type {Lightning.Component}
 */
export let pagesHost

/**
 * @type {Lightning.Stage}
 */
export let stage

/**
 * Platform driven Router configuration
 * @type {Map<string>}
 */
export let routerConfig

/**
 * Component that hosts all attached widgets
 * @type {Lightning.Component}
 */
export let widgetsHost

/**
 * Hash we point the browser to when we boot the app
 * and there is no deep-link provided
 * @type {string|Function}
 */
let rootHash

/**
 * Boot request will fire before app start
 * can be used to execute some global logic
 * and can be configured
 */
let bootRequest

/**
 * Flag if we need to update the browser location hash.
 * Router can work without.
 * @type {boolean}
 */
export let updateHash = true

/**
 * Will be called before a route starts, can be overridden
 * via routes config
 * @param from - route we came from
 * @param to - route we navigate to
 * @returns {Promise<*>}
 */
// eslint-disable-next-line
export let beforeEachRoute = async (from, to)=>{
  return true
}

/**
 * All configured routes
 * @type {Map<string, object>}
 */
export let routes = new Map()

/**
 * Store all page components per route
 * @type {Map<string, object>}
 */
export let components = new Map()

/**
 * Flag if router has been initialised
 * @type {boolean}
 */
let initialised = false

/**
 * Current page being rendered on screen
 * @type {null}
 */

let activeHash
let activePage = null
let activeRoute

/**
 *  During the process of a navigation request a new
 *  request can start, to prevent unwanted behaviour
 *  the navigate()-method stores the last accepted hash
 *  so we can invalidate any prior requests
 */
let lastAcceptedHash

/**
 * With on()-data providing behaviour the Router forced the App
 * in a Loading state. When the data-provider resolves we want to
 * change the state back to where we came from
 */
let previousState

const mixin = app => {
  // by default the Router Baseclass provides the component
  // reference in which we store our pages
  if (app.pages) {
    pagesHost = app.pages.childList
  }
  // if the app is using widgets we grab refs
  // and hide all the widgets
  if (app.widgets && app.widgets.children) {
    widgetsHost = app.widgets.childList
    // hide all widgets on boot
    widgetsHost.forEach(w => (w.visible = false))
  }
  app._handleBack = e => {
    step(-1)
    e.preventDefault()
  }
}

export const bootRouter = (config, instance) => {
  let { appInstance, routes } = config

  // if instance is provided and it's and Lightning Component instance
  if (instance && isPage(instance)) {
    app = instance
  }
  if (!app) {
    app = appInstance || AppInstance
  }

  application = app.application
  pagesHost = application.childList
  stage = app.stage
  routerConfig = getConfigMap()

  mixin(app)

  if (isArray(routes)) {
    setup(config)
  } else if (isFunction(routes)) {
    console.warn('[Router]: Calling Router.route() directly is deprecated.')
    console.warn(
      'Use object config: https://rdkcentral.github.io/Lightning-SDK/#/plugins/router/configuration'
    )
  }
}

const setup = config => {
  if (!initialised) {
    init(config)
  }
  config.routes.forEach(r => {
    // strip leading slash
    const path = r.path.replace(/\/+$/, '')
    if (!routeExists(path)) {
      const route = createRoute(r)
      routes.set(path, route)
      // if route has a configured component property
      // we store it in a different map to simplify
      // the creating and destroying per route
      if (route.component) {
        let type = route.component
        if (isComponentConstructor(type)) {
          if (!routerConfig.get('lazyCreate')) {
            type = createComponent(stage, type)
            pagesHost.a(type)
          }
        }
        components.set(path, type)
      }
    } else {
      console.error(`${path} already exists in routes configuration`)
    }
  })
}

const init = config => {
  rootHash = config.root
  if (isFunction(config.boot)) {
    bootRequest = config.boot
  }
  if (isBoolean(config.updateHash)) {
    updateHash = config.updateHash
  }
  if (isFunction(config.beforeEachRoute)) {
    beforeEachRoute = config.beforeEachRoute
  }
  if (config.bootComponent) {
    if (isPage(config.bootComponent)) {
      config.routes.push({
        path: '@router-boot-page',
        component: config.bootComponent,
      })
    } else {
      console.error(`[Router]: ${config.bootComponent} is not a valid boot component`)
    }
  }
  initialised = true
}

export const storeComponent = (route, type) => {
  if (components.has(route)) {
    components.set(route, type)
  }
}

export const getComponent = route => {
  if (components.has(route)) {
    return components.get(route)
  }
  return null
}
/**
 * Test if router needs to update browser location hash
 * @returns {boolean}
 */
export const mustUpdateLocationHash = () => {
  // we need support to either turn change hash off
  // per platform or per app
  const updateConfig = routerConfig.get('updateHash')
  return !((isBoolean(updateConfig) && !updateConfig) || (isBoolean(updateHash) && !updateHash))
}

/**
 * Will be called when a new navigate() request has completed
 * and has not been expired due to it's async nature
 * @param request
 */
export const onRequestResolved = request => {
  const hash = request.hash
  const route = request.route
  const register = request.register
  const page = request.page

  // clean up history if modifier is set
  if (getOption(route.options, 'clearHistory')) {
    setHistory([])
  } else if (hash && !isWildcard.test(route.path)) {
    updateHistory(request)
  }

  // we only update the stackLocation if a route
  // is not expired before it resolves
  storeComponent(route.path, page)

  if (request.isSharedInstance || !request.isCreated) {
    emit(page, 'changed')
  } else if (request.isCreated) {
    emit(page, 'mounted')
  }

  // only update widgets if we have a host
  if (widgetsHost) {
    updateWidgets(route.widgets, page)
  }

  // we want to clean up if there is an
  // active page that is not being shared
  // between current and previous route
  if (getActivePage() && !request.isSharedInstance) {
    cleanUp(activePage, request)
  }

  if (register.get(symbols.historyState) && isFunction(page.historyState)) {
    page.historyState(register.get(symbols.historyState))
  }

  setActivePage(page)

  activeHash = request.hash
  activeRoute = route.path

  Log.info('[route]:', route.path)
  Log.info('[hash]:', hash)
}

const cleanUp = (page, request) => {
  const route = activeRoute
  const register = request.register
  const lazyDestroy = routerConfig.get('lazyDestroy')
  const destroyOnBack = routerConfig.get('destroyOnHistoryBack')
  const keepAlive = register.get('keepAlive')
  const isFromHistory = register.get(symbols.backtrack)

  let doCleanup = false

  if (isFromHistory && (destroyOnBack || lazyDestroy)) {
    doCleanup = true
  } else if (lazyDestroy && !keepAlive) {
    doCleanup = true
  }

  if (doCleanup) {
    // grab original class constructor if
    // statemachine routed else store constructor
    storeComponent(route, page._routedType || page.constructor)

    // actual remove of page from memory
    pagesHost.remove(page)

    // force texture gc() if configured
    // so we can cleanup textures in the same tick
    if (routerConfig.get('gcOnUnload')) {
      stage.gc()
    }
  } else {
    // If we're not removing the page we need to
    // reset it's properties
    page.patch({
      x: 0,
      y: 0,
      scale: 1,
      alpha: 1,
      visible: false,
    })
  }
}

export const getActiveHash = () => {
  return activeHash
}

export const setActiveHash = hash => {
  activeHash = hash
}

export const setActivePage = page => {
  activePage = page
}

export const getActivePage = () => {
  return activePage
}

export const getActiveRoute = () => {
  return activeRoute
}

export const getLastHash = () => {
  return lastAcceptedHash
}

export const setLastHash = hash => {
  lastAcceptedHash = hash
}

export const setPreviousState = state => {
  previousState = state
}

export const getPreviousState = () => {
  return previousState
}

export const routeExists = key => {
  return routes.has(key)
}

export const getRootHash = () => {
  return rootHash
}

export const getBootRequest = () => {
  return bootRequest
}

export const getRouterConfig = () => {
  return routerConfig
}
