/**
 * A text link to a guide on middelkamp.dev. When the phone cannot open the
 * address, an alert shows it instead.
 */

import { Alert, Linking, StyleSheet, View } from 'react-native'

import { Button } from './Button'

export interface GuideLinkProps {
  label: string
  url: string
}

export function GuideLink({ label, url }: GuideLinkProps) {
  return (
    <View style={styles.link}>
      <Button
        label={label}
        variant="ghost"
        compact
        onPress={() => {
          Linking.openURL(url).catch(() => Alert.alert('Could not open the guide', url))
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  link: { alignItems: 'flex-start' }
})
