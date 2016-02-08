mw = require '../middleware'

module.exports.setup = (app) ->
  Article = require '../models/Article'
  app.get('/db/article', mw.rest.get(Article))
  app.post('/db/article', mw.auth.checkHasPermission(['admin', 'artisan']), mw.rest.post(Article))
  app.get('/db/article/:handle', mw.rest.getByHandle(Article))
  app.put('/db/article', mw.auth.checkHasPermission(['admin']), mw.rest.put(Article))
  app.post('/db/article/:handle/new-version', mw.auth.checkHasPermission(['admin', 'artisan']), mw.versions.postNewVersion(Article))

  app.get '/db/products', require('./db/product').get

  app.get '/healthcheck', (req, res) ->
    try
      async = require 'async'
      User = require '../users/User'
      async.waterfall [
        (callback) ->
          User.find({}).limit(1).exec(callback)
        , (last, callback) ->
          return("No users found") unless callback.length > 0
          User.findOne(slug: 'healthcheck').exec(callback)
        , (hcuser, callback) ->
          # Create health check user if it doesnt exist
          return callback(null, hcuser) if hcuser
          user = new User
            anonymous: false
            name: 'healthcheck'
            nameLower: 'healthcheck'
            slug: 'healthcheck'
            email: 'rob+healthcheck@codecombat.com'
            emailLower: 'rob+healthcheck@codecombat.com'
          user.set 'testGroupNumber', Math.floor(Math.random() * 256)  # also in app/core/auth
          user.save (err) ->
            return callback(err) if err
            callback(null, user)

        , (hcuser, callback) ->
          activity = hcuser.trackActivity 'healthcheck', 1
          hcuser.update {activity: activity}, callback
      ], (err) ->
        return res.status(500).send(err.toString()) if err
        res.send("OK")
    catch error
      res.status(500).send(error.toString())
