var passport = require('passport');
var allStrategies = require('./strategies.json');
var loadPassport = require('../libs/passportLoader').loadPassport;
var strategyInstances = require('../libs/passportLoader').strategyInstances;
var Strategy = require('../models/strategy.js').Strategy;
var User = require('../models/user').User;
var userRoles = require('../models/userRoles.json');
var verifyPassport = require('../libs/passportVerify').verify;
var cleanFilename = require('../libs/helpers').cleanFilename;

// These functions serialize the user model so we can keep 
// the info in the session
passport.serializeUser(function (user, done) {
  done(null, user._id);
});

passport.deserializeUser(function (id, done) {
  User.findOne({ _id : id }, function (err, user) {
    done(err, user);
  });
});

// Setup all our auth strategies
var openIdStrategies = {};
Strategy.find({}, function (err, strategies) {
  
  // Get OpenId strategies
  if (process.env.NODE_ENV === 'production') {
    for (var name in allStrategies) {
      if (!allStrategies[name].oauth) {
        openIdStrategies[name] = true;
        strategies.push({ 'name' : name, 'openid' : true });
      }
    }
  }
  
  // Load the passport module for each strategy
  strategies.forEach(function (strategy) {
    loadPassport(strategy);
  });
});

exports.auth = function (req, res, next) {
  var user = req.session.user;
  var strategy = req.body.auth || req.route.params.strategy;
  var username = req.body.username || req.session.username;

  function auth() {
    var authenticate = passport.authenticate(strategy);

    // Just in case some dumbass tries a bad /auth/* url
    if (!strategyInstances[strategy]) { return next(); }

    authenticate(req, res);
  }

  // Allow a logged in user to add a new strategy
  if (strategy && user) {
    req.session.username = user.name;
    return auth();
  } else if (user) {
    return next();
  }

  if (!username) { return res.redirect('/register?noname'); }
  // Clean the username of leading and trailing whitespace,
  // and other stuff that is unsafe in a url
  username = cleanFilename(username.replace(/^\s+|\s+$/g, ''));

  // The username could be empty after the replacements
  if (!username) { return res.redirect('/register?noname'); }

  // Store the username in the session so we still have it when they
  // get back from authentication
  if (!req.session.username) {
    req.session.username = username;
  }

  User.findOne({ name : { $regex : new RegExp('^' + username + '$', 'i') } },
    function (err, user) {
      var strategies = null;
      var strat = null;

      if (user) {
        strategies = user.strategies;
        strat = strategies.pop();

        if (req.session.newstrategy) { // authenticate with a new strategy
          delete req.session.newstrategy;
        } else if (!strategy) { // use an existing strategy
          strategy = strat;
        } else if (strategies.indexOf(strategy) === -1) {
          // add a new strategy but first authenticate with existing strategy
          req.session.newstrategy = strategy;
          strategy = strat;
        } // else use the strategy that was given in the POST
      }

      if (!strategy) { 
        return res.redirect('/register');
      } else {
        return auth();
      }
  });
};

exports.callback = function (req, res, next) {
  var strategy = req.route.params.strategy;
  var username = req.session.username;
  var newstrategy = req.session.newstrategy;
  var strategyInstance = null;
  var doneUrl = req.session.user ? '/user/edit' : '/';

  // The callback was called improperly
  if (!strategy || !username) { return next(); }

  // Get the passport strategy instance so we can alter the _verfiy method
  strategyInstance = strategyInstances[strategy];
  

  // Hijak the private verify method so we can fuck shit up freely
  // We use this library for things it was never intended to do
  if (openIdStrategies[strategy]) {
    strategyInstance._verify = function (id, done) {
      verifyPassport(id, strategy, username, req.session.user, done);
    }
  } else {
    strategyInstance._verify = 
      function (token, refreshOrSecretToken, profile, done) {
        verifyPassport(profile.id, strategy, username, req.session.user, done);
      }
  }

  // This callback will happen after the verify routine
  var authenticate = passport.authenticate(strategy, 
    function (err, user, info) {
      if (err) { return next(err); }
      if (!user) {
        return res.redirect(doneUrl + (doneUrl === '/' ? 'register' : '')
          + '?authfail');
      }

      req.logIn(user, function(err) {
        if (err) { return next(err); }

        // Store the user info in the session
        req.session.user = user;
        if (newstrategy) {
          // Allow a user to link to another acount
          return res.redirect('/auth/' + newstrategy);
        } else {
          // Delete the username that was temporarily stored
          delete req.session.username;
          return res.redirect(doneUrl);
        }
      });
  });

  authenticate(req, res, next);
}
