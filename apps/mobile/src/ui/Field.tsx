/**
 * Labelled text input for forms (docs/10 section 4): the label above in
 * `mutedForeground`, a soft `muted` input without a border, radius 14,
 * minimum height 50 (128 when multiline). An error shows as red text below;
 * the input itself does not change color.
 */

import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native'

import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SIZE, TYPE } from '@/theme/tokens'

import { useSurface } from './surface-context'

const MIN_HEIGHT = SIZE.field
const MULTILINE_MIN_HEIGHT = SIZE.fieldMultiline

export interface FieldProps {
  label?: string
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
  error?: string
  secureTextEntry?: boolean
  multiline?: boolean
  keyboardType?: KeyboardTypeOptions
  accessibilityLabel?: string
  /** Focuses the input as soon as it mounts (the Create section field in the bot action menu). */
  autoFocus?: boolean
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  secureTextEntry,
  multiline,
  keyboardType,
  accessibilityLabel,
  autoFocus
}: FieldProps) {
  const theme = useTheme()
  const surface = useSurface()

  return (
    <View style={styles.container}>
      {label ? <Text style={[styles.label, { color: theme.colors.mutedForeground }]}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.mutedForeground}
        selectionColor={theme.colors.primary}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        keyboardType={keyboardType}
        autoFocus={autoFocus}
        accessibilityLabel={accessibilityLabel ?? label}
        style={[
          styles.input,
          multiline ? styles.multiline : null,
          { backgroundColor: softFill(theme.colors, surface), color: theme.colors.foreground }
        ]}
      />
      {error ? <Text style={[styles.error, { color: theme.colors.destructive }]}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: 7,
    marginBottom: 12
  },
  label: {
    ...TYPE.footnote
  },
  input: {
    minHeight: MIN_HEIGHT,
    borderRadius: RADIUS.field,
    paddingHorizontal: 14,
    paddingVertical: 13,
    ...TYPE.body,
    lineHeight: LEADING.body
  },
  multiline: {
    minHeight: MULTILINE_MIN_HEIGHT,
    textAlignVertical: 'top'
  },
  error: {
    ...TYPE.footnote
  }
})
