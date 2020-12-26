import toEnum from "@/utils/to_enum"
import Finity from "finity"
import pQueue from 'p-queue'

import wait from '@/utils/wait'

const { default: Queue } = pQueue

const APP_VERIFIED_HEIGHT = 'APP_VERIFIED_HEIGHT'
const EVENTS_STORAGE_KEY = 'EVENTS_STORAGE_KEY'
const GRANDPA_AUTHORITIES_KEY = ':grandpa_authorities'

const redisReadQueue = new Queue({ concurrency: 3000, interval: 1 })
const redisWriteQueue = new Queue({ concurrency: 80, interval: 1 })
const fetchQueue = new Queue({ concurrency: 50, interval: 100 })

const STATES = toEnum([
	'IDLE',
	'SYNCHING_OLD_BLOCKS',
	'SYNCHING_FINALIZED',
	'ERROR'
])

const EVENTS = toEnum([
	'RECEIVING_BLOCK_HEADER',
	'FINISHING_SYNCHING_OLD_BLOCKS'
])

const _setBlock = async ({ api, number, timeout = 0, chainName, BlockModel, eventsStorageKey }) => {
	await wait(timeout)
	let block = (await redisReadQueue.add(() => BlockModel.find({ number })))[0]
	if (!block) {
		const [
			hash,
			blockData,
			events,
			eventsStorageProof,
			grandpaAuthorities,
			grandpaAuthoritiesStorageProof
		] = await fetchQueue.add(async () => {
			const hash = (await api.rpc.chain.getBlockHash(number)).toHex()
			const [
				blockData,
				events,
				eventsStorageProofData,
				grandpaAuthoritiesData,
				grandpaAuthoritiesStorageProofData
			] = await Promise.all([
				api.rpc.chain.getBlock(hash),
				api.rpc.state.getStorage(eventsStorageKey, hash),
				api.rpc.state.getReadProof([eventsStorageKey], hash),
				api.rpc.state.getStorage(GRANDPA_AUTHORITIES_KEY, hash),
				api.rpc.state.getReadProof([GRANDPA_AUTHORITIES_KEY], hash),
			])

			const eventsStorageProof = api.createType(
				'StorageProof',
				eventsStorageProofData.proof.map(i => Array.from(i.toU8a()))
			).toHex()
			const grandpaAuthorities = grandpaAuthoritiesData.value.toHex()
			const grandpaAuthoritiesStorageProof = api.createType(
				'StorageProof',
				grandpaAuthoritiesStorageProofData.proof.map(i => Array.from(i.toU8a()))
			).toHex()

			return [
				hash,
				blockData,
				events,
				eventsStorageProof,
				grandpaAuthorities,
				grandpaAuthoritiesStorageProof
			]
		})

		block = new BlockModel()
		block.id = number
		block.property({
			number,
			hash,
			header: blockData.block.header.toHex(),
			justification: blockData.justification.toHex(),
			events,
			eventsStorageProof,
			grandpaAuthorities,
			grandpaAuthoritiesStorageProof
		})
		await redisWriteQueue.add(() => block.save())
		$logger.info(`Fetched block #${number}.`, { label: chainName })
	} else {
		$logger.info(`Block #${number} found in cache.`, { label: chainName })
	}
	return
}
const setBlock = (...args) => {
	return _setBlock(...args).catch(e => {
		console.error('setBlock', args, e)
		$logger.error(e)
		if (e.errors?.number?.indexOf('notUnique') > -1 ||
			e.errors?.hash?.indexOf('notUnique') > -1) {
				$logger.info(`Fetched block #${args[0].number}.(D)`, { label: chainName })
				return
			}
		return setBlock(...args)
	})
}

const syncBlock = ({ api, redis, chainName, BlockModel }) => new Promise(resolve => {
	let oldHighest = 0
	const CHAIN_APP_VERIFIED_HEIGHT = `${chainName}:${APP_VERIFIED_HEIGHT}`
	const CHAIN_EVENTS_STORAGE_KEY = `${chainName}:${EVENTS_STORAGE_KEY}`
	const eventsStorageKey = api.query.system.events.key()

	const syncOldBlocks = async () => {
		await redis.set(CHAIN_EVENTS_STORAGE_KEY, eventsStorageKey)

		const queue = new Queue({ concurrency: 10000, interval: 0 })
		globalThis.$q = queue

		const verifiedHeight = ((await redis.get(CHAIN_APP_VERIFIED_HEIGHT)) || 1) - 1
		$logger.info(`${CHAIN_APP_VERIFIED_HEIGHT}: ${verifiedHeight}`)
		
		for (let number = verifiedHeight; number < oldHighest; number++) {
			queue.add(() => setBlock({ api, redis, number, chainName, BlockModel, eventsStorageKey }))
		}

		await queue.onIdle().catch(console.error)
		await redis.set(CHAIN_APP_VERIFIED_HEIGHT, oldHighest)
		$logger.info(`${CHAIN_APP_VERIFIED_HEIGHT}: ${await redis.get(CHAIN_APP_VERIFIED_HEIGHT)}`)

		return
	}

	const stateMachine = Finity.configure()
		.initialState(STATES.IDLE)
			.on(EVENTS.RECEIVING_BLOCK_HEADER)
				.transitionTo(STATES.SYNCHING_OLD_BLOCKS)
				.withAction((...{ 2: { eventPayload: header } }) => {
					$logger.info('Start synching blocks...', { label: chainName })
					oldHighest = header.number.toNumber()
				})
		.state(STATES.SYNCHING_OLD_BLOCKS)
			.do(() => syncOldBlocks())
				.onSuccess().transitionTo(STATES.SYNCHING_FINALIZED).withAction(() => {
					$logger.info('Old blocks synched.', { label: chainName })
					resolve()
				})
				.onFailure().transitionTo(STATES.ERROR).withAction((from, to, context) => {
					console.error('error', context.error)
					$logger.error(context.error, { label: chainName })
				})
			.onAny().ignore()
		.state(STATES.SYNCHING_FINALIZED)
			.onAny().ignore()
		.state(STATES.ERROR)
			.do(() => process.exit(-2))
				.onSuccess().selfTransition()
			.onAny().ignore()

	const worker = stateMachine.start()
	api.rpc.chain.subscribeFinalizedHeads(header => {
		const number = header.number.toNumber()

		if (oldHighest <= 0) {
			worker.handle(EVENTS.RECEIVING_BLOCK_HEADER, header)
		}
		
		setBlock({ api, redis, number, chainName, BlockModel, eventsStorageKey })
	})
})

export default syncBlock