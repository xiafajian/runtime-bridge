import { APP_MESSAGE_QUEUE_NAME } from './constants'
import { getPool } from '../lifecycle/worker'
import BeeQueue from 'bee-queue'

const createSubQueue = ({ redisUrl, pid, actions, txQueue, context }) => {
  const queueName = `${APP_MESSAGE_QUEUE_NAME}__${pid}`
  const ret = new BeeQueue(queueName, {
    redis: {
      url: redisUrl,
    },
  })

  ret.dispatch = (...args) => {
    const job = ret.createJob(...args)
    return waitForJob(queueName, job)
  }

  ret.process(1, async (job) => {
    $logger.info(job.data, `Pool #${pid}: Processing job #${job.id}...`)

    const pool = await getPool(pid, context, true)

    const actionFn = actions[job.data.action]

    return actionFn(job.data.payload, {
      txQueue,
      pool,
      operator: pool.pair,
      context,
    })
  })

  return ret
}

const createTradeQueue = (redisUrl) => {
  const queueName = `${APP_MESSAGE_QUEUE_NAME}__main`
  const ret = new BeeQueue(queueName, {
    redis: {
      url: redisUrl,
    },
  })

  ret.dispatch = (...args) => {
    const job = ret.createJob(...args)
    return waitForJob(queueName, job)
  }

  return ret
}

const waitForJob = (queueName, job) =>
  new Promise((resolve, reject) => {
    job
      .save()
      .then(() => {
        job.on('succeeded', (result) => {
          resolve(result)
        })
        job.on('retrying', (err) => {
          $logger.warn(
            { queueName },
            err,
            `Job #${job.id} failed with error ${err.message} but is being retried!`
          )
        })
        job.on('failed', (err) => {
          $logger.warn(
            { queueName },
            err,
            `Job #${job.id} failed with error ${err.message}.`
          )
          reject(err)
        })
      })
      .catch(reject)
  })

export default createTradeQueue
export { waitForJob, createSubQueue, createTradeQueue }
