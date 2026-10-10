/// <reference types="node" />
/**
 * app.json declares the lowest iOS and Android versions the app supports
 * (ADR-039). Expo and React Native each set a floor of their own, and an
 * upgrade can raise it. A declared minimum below the floor only fails in the
 * native release build, on a macOS runner, after a tag; this test fails in
 * the upgrade's pull request instead.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '..')

type PluginEntry = string | [string, Record<string, unknown>]

type ExpoConfig = {
  ios?: { deploymentTarget?: string }
  plugins?: PluginEntry[]
}

function readAppFile(relativePath: string): string {
  return readFileSync(path.join(APP, relativePath), 'utf8')
}

function readExpoConfig(): ExpoConfig {
  return JSON.parse(readAppFile('app.json')).expo
}

function declaredAndroidMinSdk(config: ExpoConfig): unknown {
  const buildProperties = config.plugins?.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-build-properties')
  if (!Array.isArray(buildProperties)) return undefined
  const android = buildProperties[1].android as { minSdkVersion?: unknown } | undefined
  return android?.minSdkVersion
}

/** The iOS version in Expo's own podspec; every Expo module pod requires it. */
function expoIosFloor(): string {
  const podspec = readAppFile('node_modules/expo/Expo.podspec')
  const iosPlatform = podspec.match(/:ios => '(\d+(?:\.\d+)*)'/)
  if (!iosPlatform) throw new Error('node_modules/expo/Expo.podspec has no `:ios => \'X.Y\'` platform line.')
  return iosPlatform[1]
}

/** The minSdk in React Native's version catalog, which Expo's Gradle plugin uses unless the app overrides it. */
function reactNativeAndroidFloor(): number {
  const catalog = readAppFile('node_modules/react-native/gradle/libs.versions.toml')
  const minSdkLine = catalog.match(/^minSdk = "(\d+)"$/m)
  if (!minSdkLine) throw new Error('node_modules/react-native/gradle/libs.versions.toml has no `minSdk = "N"` line.')
  return Number(minSdkLine[1])
}

/** Compares dotted versions part by part as numbers, so 16.10 is above 16.4. */
function isAtLeast(version: string, floor: string): boolean {
  const versionParts = version.split('.').map(Number)
  const floorParts = floor.split('.').map(Number)
  for (let i = 0; i < Math.max(versionParts.length, floorParts.length); i++) {
    const difference = (versionParts[i] ?? 0) - (floorParts[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

describe('minimum OS versions', () => {
  it('declares an iOS deployment target no lower than the Expo floor', () => {
    const deploymentTarget = readExpoConfig().ios?.deploymentTarget
    const floor = expoIosFloor()

    expect(deploymentTarget, 'app.json needs expo.ios.deploymentTarget (ADR-039).').toMatch(/^\d+(\.\d+)*$/)
    expect(
      isAtLeast(deploymentTarget!, floor),
      `app.json declares iOS ${deploymentTarget}, but the installed Expo requires iOS ${floor}. Raise expo.ios.deploymentTarget (ADR-039).`
    ).toBe(true)
  })

  it('declares an Android minSdkVersion no lower than the React Native floor', () => {
    const minSdkVersion = declaredAndroidMinSdk(readExpoConfig())
    const floor = reactNativeAndroidFloor()

    expect(minSdkVersion, 'app.json needs android.minSdkVersion in the expo-build-properties plugin (ADR-039).').toBeTypeOf('number')
    expect(
      (minSdkVersion as number) >= floor,
      `app.json declares Android API ${minSdkVersion}, but the installed React Native requires API ${floor}. Raise android.minSdkVersion in the expo-build-properties plugin (ADR-039).`
    ).toBe(true)
  })
})
