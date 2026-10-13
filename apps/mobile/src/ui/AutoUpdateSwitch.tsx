/**
 * The switch for keeping a connection's server plugin up to date by itself.
 * It reads and writes `Connection.autoUpdatePlugin`, which is on until the
 * user turns it off.
 */

import { AUTO_UPDATE_LABEL, autoUpdate } from '@/features/server'
import { useDeviceStore, type Connection } from '@/state/device-store'

import { Card } from './Card'
import { SwitchRow } from './SwitchRow'

export interface AutoUpdateSwitchProps {
  connection: Connection
}

export function AutoUpdateSwitch({ connection }: AutoUpdateSwitchProps) {
  const updateConnection = useDeviceStore(s => s.updateConnection)
  return (
    <Card>
      <SwitchRow label={AUTO_UPDATE_LABEL} value={autoUpdate(connection)} onValueChange={on => updateConnection(connection.id, { autoUpdatePlugin: on })} />
    </Card>
  )
}
