/**
 * The switch for keeping a connection's server plugin up to date by itself.
 * It reads and writes `Connection.autoUpdatePlugin`, which is on until the
 * user turns it off.
 */

import { AUTO_UPDATE_LABEL, autoUpdate } from '@/features/server'
import { useDeviceStore, type Connection } from '@/state/device-store'

import { Card } from './Card'
import { ListRow } from './ListRow'
import { SwitchRow, Toggle } from './SwitchRow'

export interface AutoUpdateSwitchProps {
  connection: Connection
  /** True inside a settings `Group`: a row with an icon and the switch on its right, like the other settings switches, in place of a card of its own. */
  inGroup?: boolean
}

export function AutoUpdateSwitch({ connection, inGroup = false }: AutoUpdateSwitchProps) {
  const updateConnection = useDeviceStore(s => s.updateConnection)
  const value = autoUpdate(connection)
  const onValueChange = (on: boolean) => updateConnection(connection.id, { autoUpdatePlugin: on })
  if (inGroup) {
    return <ListRow title={AUTO_UPDATE_LABEL} icon="refresh-cw" right={<Toggle value={value} onValueChange={onValueChange} accessibilityLabel={AUTO_UPDATE_LABEL} />} />
  }
  return (
    <Card>
      <SwitchRow label={AUTO_UPDATE_LABEL} value={value} onValueChange={onValueChange} />
    </Card>
  )
}
