/**
 * A text link to a guide on middelkamp.dev. When the phone cannot open the
 * address, an alert shows it instead. `openPage` does the same for any page
 * there, such as the privacy policy.
 */

import { Alert, Linking, StyleSheet, View } from 'react-native'

import { Button } from './Button'

export interface GuideLinkProps {
  label: string
  url: string
}

/** Opens a page, or shows its address in an alert named after `page` ("the privacy policy") when the phone cannot open it. */
export function openPage(url: string, page: string): void {
  Linking.openURL(url).catch(() => Alert.alert(`Could not open ${page}`, url))
}

/** Opens a guide, or shows its address in an alert when the phone cannot open it. For a guide behind a full-width button. */
export function openGuide(url: string): void {
  openPage(url, 'the guide')
}

export function GuideLink({ label, url }: GuideLinkProps) {
  return (
    <View style={styles.link}>
      <Button label={label} variant="ghost" compact onPress={() => openGuide(url)} />
    </View>
  )
}

const styles = StyleSheet.create({
  link: { alignItems: 'flex-start' }
})
