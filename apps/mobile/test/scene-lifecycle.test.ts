/// <reference types="node" />
import { readdirSync } from 'node:fs'
import path from 'node:path'

import type { ExpoConfig } from 'expo/config'
import { describe, expect, it } from 'vitest'

import withSceneLifecycle from '../plugins/with-scene-lifecycle.js'

const { applySceneLifecycle, SCENE_DELEGATE, SCENE_MANIFEST } = withSceneLifecycle

/** The launch method of ios/Ergates/AppDelegate.swift as `expo prebuild` writes it for SDK 57. */
const TEMPLATE = [
  '    reactNativeDelegate = delegate',
  '    reactNativeFactory = factory',
  '',
  '#if os(iOS) || os(tvOS)',
  '    window = UIWindow(frame: UIScreen.main.bounds)',
  '    factory.startReactNative(',
  '      withModuleName: "main",',
  '      in: window,',
  '      launchOptions: launchOptions)',
  '#endif',
  '',
  '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
  '  }',
  '',
].join('\n')

const ADOPTED = [
  '    reactNativeDelegate = delegate',
  '    reactNativeFactory = factory',
  '',
  '    // SceneDelegate creates the window and starts React Native in it',
  '    // (plugins/with-scene-lifecycle.js).',
  '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
  '  }',
  '',
].join('\n')

const CONFIG: ExpoConfig = { name: 'Ergates', slug: 'ergates' }

describe('applySceneLifecycle', () => {
  it('leaves the window and the React Native start to the scene delegate', () => {
    expect(applySceneLifecycle(TEMPLATE)).toBe(ADOPTED)
  })

  it('leaves a file it already changed alone', () => {
    expect(applySceneLifecycle(ADOPTED)).toBe(ADOPTED)
  })

  it('stops when the template no longer starts React Native at launch', () => {
    const sdk58 = TEMPLATE.replace(/#if os\(iOS\)[\s\S]*#endif\n/, '')
    expect(() => applySceneLifecycle(sdk58)).toThrow('AppDelegate.swift does not create the window')
  })
})

describe('SCENE_MANIFEST', () => {
  it('declares one window scene handled by SceneDelegate', () => {
    expect(SCENE_MANIFEST).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    })
  })
})

describe('SCENE_DELEGATE', () => {
  it('is the window scene delegate the manifest names', () => {
    expect(SCENE_DELEGATE).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate {')
  })

  it('starts React Native in a window of the connecting scene', () => {
    expect(SCENE_DELEGATE).toContain('UIWindow(windowScene: windowScene)')
    expect(SCENE_DELEGATE).toContain('factory.startReactNative(')
  })

  it('passes links and user activities on to the app delegate', () => {
    expect(SCENE_DELEGATE).toContain('func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>)')
    expect(SCENE_DELEGATE).toContain('func scene(_ scene: UIScene, continue userActivity: NSUserActivity)')
  })
})

describe('withSceneLifecycle', () => {
  it('adds the scene manifest to Info.plist', async () => {
    const config = withSceneLifecycle({ ...CONFIG })
    const mod = config.mods?.ios?.infoPlist
    expect(mod).toBeTypeOf('function')

    const result = await mod!({
      ...config,
      modResults: { CFBundleDisplayName: 'Ergates' },
      modRequest: { projectRoot: '/app', platformProjectRoot: '/app/ios', modName: 'infoPlist', platform: 'ios', introspect: false },
    })

    expect(result.modResults).toEqual({ CFBundleDisplayName: 'Ergates', UIApplicationSceneManifest: SCENE_MANIFEST })
  })

  it('rewrites AppDelegate.swift through the mod', async () => {
    const config = withSceneLifecycle({ ...CONFIG })
    const mod = config.mods?.ios?.appDelegate
    expect(mod).toBeTypeOf('function')

    const result = await mod!({
      ...config,
      modResults: { path: 'ios/Ergates/AppDelegate.swift', contents: TEMPLATE, language: 'swift' },
      modRequest: { projectRoot: '/app', platformProjectRoot: '/app/ios', modName: 'appDelegate', platform: 'ios', introspect: false },
    })

    expect(result.modResults.contents).toBe(ADOPTED)
  })
})

describe('the installed Expo SDK', () => {
  it('has no scene delegate of its own; from SDK 58 on, remove plugins/with-scene-lifecycle.js', () => {
    const expoSources = readdirSync(path.resolve(import.meta.dirname, '../node_modules/expo/ios'), { recursive: true })
    expect(expoSources.filter(file => String(file).endsWith('ExpoAppSceneDelegate.swift'))).toEqual([])
  })
})
