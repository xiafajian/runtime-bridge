import packageJson from '../../package.json'
import { Command } from 'commander'
import { createLogger } from 'bunyan'

import applyFetch from './fetch'
import applyCommunicate from './communicate'
import applyTrade from './trade'
import applyCommon from './common'
import applyAccount from './account'

globalThis.$logger = createLogger({
  level: 'info',
  name: 'prb'
})

const cli = new Command()

cli.version(packageJson.version)

applyCommon(cli)
applyFetch(cli)
applyCommunicate(cli)
applyTrade(cli)
applyAccount(cli)

cli.parse(process.argv)
