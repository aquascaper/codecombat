/* global ObjectId */
/* global db */
/* global printjson */
// Insert per-day active user counts into analytics.perdays collection

// Usage:
// mongo <address>:<port>/<database> <script file> -u <username> -p <password>

try {
  var logDB = new Mongo("localhost").getDB("analytics")
  var scriptStartTime = new Date();
  var analyticsStringCache = {};

  var numDays = 30;
  var daysInMonth = 30;

  var startDay = new Date();
  var today = startDay.toISOString().substr(0, 10);
  startDay.setUTCDate(startDay.getUTCDate() - numDays);
  startDay = startDay.toISOString().substr(0, 10);

  var activeUserEvents = ['Finished Signup', 'Started Level'];

  log("Today is " + today);
  log("Start day is " + startDay);

  log("Getting active user counts..");
  var activeUserCounts = getActiveUserCounts(startDay, activeUserEvents);
  // printjson(activeUserCounts);
  log("Inserting active user counts..");
  for (var day in activeUserCounts) {
    if (today === day) continue; // Never save data for today because it's incomplete
    for (var event in activeUserCounts[day]) {
      // print(day, '\t', event, '\t', activeUserCounts[day][event]);
      insertEventCount(event, day, activeUserCounts[day][event]);
    }
  }
}
catch(err) {
  log("ERROR!");
  printjson(err);
}
finally {
  log("Script runtime: " + (new Date() - scriptStartTime));
}

function getActiveUserCounts(startDay, activeUserEvents) {
  // Counts active users per day
  if (!startDay) return {};
  
  var cursor, doc;

  log("Finding active user log events..");
  var startObj = objectIdWithTimestamp(ISODate(startDay + "T00:00:00.000Z"));
  var queryParams = {$and: [
    {_id: {$gte: startObj}},
    {'event': {$in: activeUserEvents}}
  ]};
  cursor = logDB['log'].find(queryParams);

  var campaignUserMap = {};
  var dayUserMap = {};
  var userIDs = [];
  while (cursor.hasNext()) {
    doc = cursor.next();
    var created = doc._id.getTimestamp().toISOString();
    var day = created.substring(0, 10);
    var user = doc.user.valueOf();
    campaignUserMap[user] = true;
    if (!dayUserMap[day]) dayUserMap[day] = {};
    dayUserMap[day][user] = true;
    userIDs.push(ObjectId(user));
  }
  print('User count: ', userIDs.length);

  log("Finding classroom members..");
  var classroomUserObjectIds = [];
  var batchSize = 100000;
  for (var j = 0; j < userIDs.length / batchSize + 1; j++) {
    cursor = db.classrooms.find({members: {$in: userIDs.slice(j * batchSize, j * batchSize + batchSize)}}, {members: 1});
    while (cursor.hasNext()) {
      doc = cursor.next();
      if (doc.members) {
        for (var i = 0; i < doc.members.length; i++) {
          var userID = doc.members[i].valueOf();
          campaignUserMap[userID] = false;
          classroomUserObjectIds.push(doc.members[i]);
        }
      }
    }
  }
  log("Classroom user count: " + classroomUserObjectIds.length);

  // Classrooms free/trial/paid
  // Paid user: user.coursePrepaidID set means access to paid courses
  // Trial user: prepaid.properties.trialRequestID means access was via trial
  // Free: not paid, not trial
  log("Finding classroom users free/trial/paid status..");
  var userEventMap = {};
  var prepaidUsersMap = {};
  var prepaidIDs = [];
  cursor = db.users.find({_id: {$in: classroomUserObjectIds}}, {coursePrepaidID: 1});
  while (cursor.hasNext()) {
    doc = cursor.next();
    if (doc.coursePrepaidID) {
      userEventMap[doc._id.valueOf()] = 'DAU classroom paid';
      if (!prepaidUsersMap[doc.coursePrepaidID.valueOf()]) prepaidUsersMap[doc.coursePrepaidID.valueOf()] = [];
      prepaidUsersMap[doc.coursePrepaidID.valueOf()].push(doc._id.valueOf()); 
      prepaidIDs.push(doc.coursePrepaidID);
    }
    else {
      userEventMap[doc._id.valueOf()] = 'DAU classroom free';
    }
  }
  cursor = db.prepaids.find({_id: {$in: prepaidIDs}}, {properties: 1});
  while (cursor.hasNext()) {
    doc = cursor.next();
    if (doc.properties && doc.properties.trialRequestID) {
      for (var i = 0; i < prepaidUsersMap[doc._id.valueOf()].length; i++) {
        userEventMap[prepaidUsersMap[doc._id.valueOf()][i]] = 'DAU classroom trial';
      }
    }
  }

  // Campaign free/paid
  // Monthly sub: recipient for payment.stripe.subscriptionID == 'basic'
  // Yearly sub: recipient for paymen.stripe.gems == 42000
  // TODO: missing a number of corner cases here (e.g. cancelled sub, purchased via admin)
  var campaignUserIDs = [];
  for (var userID in campaignUserMap) {
    if (campaignUserMap[userID]) campaignUserIDs.push(ObjectId(userID));
  }
  log("Finding campaign paid users..");
  var dayUserPaidMap = {};
  batchSize = 100000;
  for (var j = 0; j < campaignUserIDs.length / batchSize + 1; j++) {
    cursor = db.payments.find({$and: [
      {recipient: {$in: campaignUserIDs.slice(j * batchSize, j * batchSize + batchSize)}}, 
      {$or: [
        {'stripe.subscriptionID': 'basic'},
        {gems: 42000}
      ]}
    ]}, {created: 1, gems: 1, recipient: 1});
    while (cursor.hasNext()) {
      doc = cursor.next();
      var currentDate = new Date(doc.created || doc._id.getTimestamp());
      userID = doc.recipient.valueOf();
      var numDays = doc.gems === 42000 ? 365 : 30;
      for (var i = 0; i < numDays; i++) {
        day = currentDate.toISOString().substring(0, 10);
        if (!dayUserPaidMap[day]) dayUserPaidMap[day] = {};
        dayUserPaidMap[day][userID] = true;
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }
    }
  }

  var updateActiveUserCounts = function (activeUsersCounts, day, user, isMAU) {
    var event = userEventMap[user];
    if (!event) {
      if (dayUserPaidMap[day] && dayUserPaidMap[day][user]) {
        event = 'DAU campaign paid';
      }
      else {
        event = 'DAU campaign free';
      }
    }
    if (isMAU) event = event.replace('DAU', 'MAU');
    if (!activeUsersCounts[day]) activeUsersCounts[day] = {};
    if (!activeUsersCounts[day][event]) activeUsersCounts[day][event] = 0;
    activeUsersCounts[day][event]++;
  };

  log("Calculating DAUs..");
  var activeUsersCounts = {};
  var monthlyActives = [];
  for (day in dayUserMap) {
    for (var user in dayUserMap[day]) {
      updateActiveUserCounts(activeUsersCounts, day, user, false);
    }
    monthlyActives.push({day: day, users: dayUserMap[day]});
  }

  // Calculate monthly actives for each day, starting when we have enough data
  log("Calculating MAUs..");
  monthlyActives.sort(function (a, b) {return a.day.localeCompare(b.day);});
  for (var i = daysInMonth - 1; i < monthlyActives.length; i++) {
    for (var j = i - daysInMonth + 1; j <= i; j++) {
      day = monthlyActives[i].day;
      for (var user in monthlyActives[j].users) {
        updateActiveUserCounts(activeUsersCounts, day, user, true);
      }
    }
  }
  
  // NOTE: analytics logging failure resulted in lost data for 2/2/16 through 2/9/16.  Approximating those missing days here.
  // Correction for a given event: previous week's value + previous week's diff from start to end if > 0
  var missingDataDays = ['2016-02-02', '2016-02-03', '2016-02-04', '2016-02-05', '2016-02-06', '2016-02-07', '2016-02-08', '2016-02-09'];
  for (var day in activeUsersCounts) {
    if (missingDataDays.indexOf(day) >= 0) {
      var prevDate = new Date(day + "T00:00:00.000Z");
      prevDate.setUTCDate(prevDate.getUTCDate() - 7);
      var prevStartDate = new Date(prevDate);
      prevStartDate.setUTCDate(prevStartDate.getUTCDate() - 7);
      var prevStartDay = prevStartDate.toISOString().substring(0, 10);
      if (activeUsersCounts[prevStartDay]) {
        var prevDay = prevDate.toISOString().substring(0, 10);
        for (var event in activeUsersCounts[day]) {
          var prevValue = activeUsersCounts[prevDay][event];
          var prevStartValue = activeUsersCounts[prevStartDay][event];
          var prevWeekDiff = Math.max(prevValue - prevStartValue, 0);
          var betterValue = prevValue + prevWeekDiff;
          activeUsersCounts[day][event] = betterValue;
          // var currentValue = activeUsersCounts[day][event];
          // print(prevStartDay, '\t', prevDay, '\t', prevValue, '-', prevStartValue, '\t', prevWeekDiff, '\t', day, '\t', event, '\t', prevValue, '\t', currentValue, '\t', betterValue);
        }
      }
    }
  }

  return activeUsersCounts;
}


// *** Helper functions ***

function log(str) {
  print(new Date().toISOString() + " " + str);
}

function objectIdWithTimestamp(timestamp) {
  // Convert string date to Date object (otherwise assume timestamp is a date)
  if (typeof(timestamp) == 'string') timestamp = new Date(timestamp);
  // Convert date object to hex seconds since Unix epoch
  var hexSeconds = Math.floor(timestamp/1000).toString(16);
  // Create an ObjectId with that hex timestamp
  var constructedObjectId = ObjectId(hexSeconds + "0000000000000000");
  return constructedObjectId
}

function getAnalyticsString(str) {
  if (analyticsStringCache[str]) return analyticsStringCache[str];

  // Find existing string
  var doc = db['analytics.strings'].findOne({v: str});
  if (doc) {
    analyticsStringCache[str] = doc._id;
    return analyticsStringCache[str];
  }

  // Insert string
  // http://docs.mongodb.org/manual/tutorial/create-an-auto-incrementing-field/#auto-increment-optimistic-loop
  doc = {v: str};
  while (true) {
    var cursor = db['analytics.strings'].find({}, {_id: 1}).sort({_id: -1}).limit(1);
    var seq = cursor.hasNext() ? cursor.next()._id + 1 : 1;
    doc._id = seq;
    var results = db['analytics.strings'].insert(doc);
    if (results.hasWriteError()) {
      if ( results.writeError.code == 11000 /* dup key */ ) continue;
      else throw new Error("ERROR: Unexpected error inserting data: " + tojson(results));
    }
    break;
  }

  // Find new string entry
  doc = db['analytics.strings'].findOne({v: str});
  if (doc) {
    analyticsStringCache[str] = doc._id;
    return analyticsStringCache[str];
  }
  throw new Error("ERROR: Did not find analytics.strings insert for: " + str);
}

function insertEventCount(event, day, count) {
  // analytics.perdays schema in server/analytics/AnalyticsPeryDay.coffee
  day = day.replace(/-/g, '');

  var eventID = getAnalyticsString(event);
  var filterID = getAnalyticsString('all');

  var queryParams = {$and: [{d: day}, {e: eventID}, {f: filterID}]};
  var doc = db['analytics.perdays'].findOne(queryParams);
  if (doc && doc.c === count) return;

  if (doc && doc.c !== count) {
    // Update existing count, assume new one is more accurate
    // log("Updating count in db for " + day + " " + event + " " + doc.c + " => " + count);
    var results = db['analytics.perdays'].update(queryParams, {$set: {c: count}});
    if (results.nMatched !== 1 && results.nModified !== 1) {
      log("ERROR: update event count failed");
      printjson(results);
    }
  }
  else {
    var insertDoc = {d: day, e: eventID, f: filterID, c: count};
    var results = db['analytics.perdays'].insert(insertDoc);
    if (results.nInserted !== 1) {
      log("ERROR: insert event failed");
      printjson(results);
      printjson(insertDoc);
    }
    // else {
    //   log("Added " + day + " " + event + " " + count);
    // }
  }
}
