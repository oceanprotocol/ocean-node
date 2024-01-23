import express from 'express'

export const computeRoutes = express.Router()

computeRoutes.get('/api/services/computeEnvironments', async (req, res) => {
  try {
    // const environments = await // get compute environments
    // if (environments) {
    //   res.json(environments)
    // } else {
    //   res.status(404).send('Compute environments not found')
    // }
  } catch (error) {
    res.status(500).send('Internal Server Error')
  }
})
