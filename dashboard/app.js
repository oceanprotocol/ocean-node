const express = require('express')

const app = express()
const path = require('path')

express.static.mime.define({ 'image/svg+xml': ['svg'] })

app.use((req, res, next) => {
  if (/(.ico|.js|.css|.jpg|.png|.svg|.map)$/i.test(req.path)) {
    next()
  } else {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate')
    res.header('Expires', '-1')
    res.header('Pragma', 'no-cache')
    res.sendFile(path.join(__dirname, 'out', 'index.html'))
  }
})
app.use(express.static(path.join(__dirname, 'out')))

app.listen(8080, function () {
  console.log('Server is running on localhost8080')
})
