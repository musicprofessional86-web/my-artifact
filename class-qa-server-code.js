/* Class Q&A: storage bridge.
   The original app talks to a server at /api/*. This page has no server, so
   these routes are answered here, using the page's shared database
   (claude.use("db")). The app's screens and API shapes are unchanged. */
(function () {
  "use strict";

  var SESSION_KEY = "classqa.session";
  var SUBJECTS = ["General", "Maths", "Science", "English", "Social Studies", "Computer", "Other"];
  var STUDENT_ID_RE = /^[A-Za-z0-9_-]{2,20}$/;
  var DOC_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  var memSession = null;

  function toHex(u8) {
    return Array.prototype.map.call(u8, function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }
  function randomHex(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return toHex(a);
  }
  async function sha256Hex(text) {
    var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("class-qa:" + text));
    return toHex(new Uint8Array(digest));
  }
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function reply(status, data) {
    return new Response(JSON.stringify(data), {
      status: status,
      headers: { "Content-Type": "application/json" }
    });
  }
  function fail(status, message) {
    return new Response(message, {
      status: status,
      headers: { "Content-Type": "text/plain" }
    });
  }

  // Session lives in this browser only (per-viewer convenience).
  function readSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return memSession;
  }
  function saveSession(s) {
    memSession = s;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function clearSession() {
    memSession = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function startSession(me) {
    var session = { token: randomHex(16), me: me };
    saveSession(session);
    return reply(200, { token: session.token, me: me });
  }

  // Used by the app on load so a reload keeps the viewer signed in.
  window.__classqaRestore = function () {
    var s = readSession();
    return s && s.me ? s.me : null;
  };

  async function getDb() {
    try {
      var c = window.claude;
      return c && typeof c.use === "function" ? await c.use("db") : null;
    } catch (e) {
      return null;
    }
  }

  async function stillEnrolled(db, me) {
    var snap = await db.collection("students").doc(me.student.studentId.toLowerCase()).get();
    return snap.exists;
  }

  // ---- auth -------------------------------------------------------------

  async function joinStudent(db, body) {
    var studentId = String(body.studentId || "").trim();
    var name = String(body.name || "").trim();
    var password = String(body.password || "");
    if (!STUDENT_ID_RE.test(studentId)) return fail(400, "Student ID must be 2–20 letters, numbers, - or _");
    if (name.length < 2 || name.length > 60) return fail(400, "Please enter your full name");
    if (password.length < 4 || password.length > 64) return fail(400, "Use at least 4 characters");

    var key = studentId.toLowerCase();
    var ref = db.collection("students").doc(key);
    var snap = await ref.get();
    if (snap.exists) return fail(409, "That Student ID is already taken. Try another, or sign in.");

    await ref.set({
      studentId: studentId,
      name: name,
      pwHash: await sha256Hex(key + ":" + password),
      createdAt: Date.now()
    });
    return startSession({ role: "student", student: { studentId: studentId, name: name } });
  }

  async function loginStudent(db, body) {
    var studentId = String(body.studentId || "").trim();
    var password = String(body.password || "");
    var bad = "Wrong Student ID or password";
    if (!STUDENT_ID_RE.test(studentId)) return fail(401, bad);

    var key = studentId.toLowerCase();
    var snap = await db.collection("students").doc(key).get();
    if (!snap.exists) return fail(401, bad);
    if ((await sha256Hex(key + ":" + password)) !== snap.data().pwHash) return fail(401, bad);

    var s = snap.data();
    return startSession({ role: "student", student: { studentId: s.studentId, name: s.name } });
  }

  async function loginTeacher(db, body) {
    var pin = String(body.pin || "").trim();
    if (!pin) return fail(400, "Enter the teacher PIN");

    var ref = db.doc("settings/teacher");
    var snap = await ref.get();
    var pinHash = await sha256Hex("teacher:" + pin);
    if (!snap.exists) {
      // No PIN yet: the page owner sets it on first sign-in (only the owner
      // can write to settings; see the db rules declared at publish).
      try {
        await ref.set({ pinHash: pinHash, createdAt: Date.now() });
      } catch (e) {
        return fail(403, "The teacher PIN hasn't been set yet. The page owner needs to open the class page and enter a PIN first.");
      }
    } else if (snap.data().pinHash !== pinHash) {
      return fail(401, "That PIN doesn't match. Try again.");
    }
    return startSession({ role: "teacher" });
  }

  // ---- questions --------------------------------------------------------

  async function listQuestions(db, me) {
    var isTeacher = me.role === "teacher";
    var myKey = me.role === "student" ? me.student.studentId.toLowerCase() : null;
    var qs = await db.collection("questions").get();
    var votes = await db.collection("upvotes").get();

    var tally = {};
    votes.docs.forEach(function (d) {
      if (!d.exists) return;
      var v = d.data();
      var t = tally[v.questionId] || (tally[v.questionId] = { count: 0, byMe: false });
      t.count += 1;
      if (myKey !== null && v.voter === myKey) t.byMe = true;
    });

    var list = qs.docs.filter(function (d) { return d.exists; }).map(function (d) {
      var q = d.data();
      var isMine = myKey !== null && q.authorKey === myKey;
      var t = tally[d.id] || { count: 0, byMe: false };
      return {
        id: d.id,
        body: q.body,
        subject: q.subject,
        anonymous: !!q.anonymous,
        answer: q.answer || null,
        createdAt: q.createdAt,
        displayName: q.anonymous && !isMine ? "Anonymous classmate" : q.authorName,
        studentId: isTeacher ? q.studentId : undefined,
        isMine: isMine,
        upvotes: t.count,
        upvotedByMe: t.byMe
      };
    });
    list.sort(function (a, b) { return b.createdAt - a.createdAt; });
    return reply(200, list);
  }

  async function askQuestion(db, me, body) {
    if (me.role !== "student") return fail(403, "Only students can ask questions");
    if (!(await stillEnrolled(db, me))) return fail(401, "This account is no longer in the class. Ask your teacher.");

    var text = String(body.body || "").trim();
    var subject = String(body.subject || "General");
    if (text.length < 5) return fail(400, "Please write a little more");
    if (text.length > 2000) return fail(400, "Keep it under 2000 characters");
    if (SUBJECTS.indexOf(subject) < 0) return fail(400, "Pick a subject from the list");

    var id = randomHex(16);
    await db.collection("questions").doc(id).set({
      body: text,
      subject: subject,
      anonymous: body.anonymous === true,
      answer: null,
      answeredAt: null,
      createdAt: Date.now(),
      studentId: me.student.studentId,
      authorKey: me.student.studentId.toLowerCase(),
      authorName: me.student.name
    });
    return reply(200, { ok: true, id: id });
  }

  async function answerQuestion(db, me, qid, body) {
    if (me.role !== "teacher") return fail(403, "Only the teacher can reply");
    var answer = String(body.answer || "").trim();
    if (!answer) return fail(400, "Write a reply first");
    if (answer.length > 2000) return fail(400, "Keep it under 2000 characters");

    var ref = db.collection("questions").doc(qid);
    var snap = await ref.get();
    if (!snap.exists) return fail(404, "That question no longer exists");
    await ref.update({ answer: answer, answeredAt: Date.now() });
    return reply(200, { ok: true });
  }

  async function toggleMeToo(db, me, qid) {
    if (me.role !== "student") return fail(403, "Only students can say me too");
    if (!(await stillEnrolled(db, me))) return fail(401, "This account is no longer in the class. Ask your teacher.");

    var qsnap = await db.collection("questions").doc(qid).get();
    if (!qsnap.exists) return fail(404, "That question no longer exists");
    var voter = me.student.studentId.toLowerCase();
    if (qsnap.data().authorKey === voter) return fail(400, "That's your own question");

    var vref = db.collection("upvotes").doc(qid + "__" + voter);
    var vsnap = await vref.get();
    if (vsnap.exists) {
      await vref.delete();
    } else {
      await vref.set({ questionId: qid, voter: voter, createdAt: Date.now() });
    }
    return reply(200, { ok: true });
  }

  async function deleteQuestion(db, me, qid) {
    var ref = db.collection("questions").doc(qid);
    var snap = await ref.get();
    if (!snap.exists) return reply(200, { ok: true });

    var q = snap.data();
    var mine = me.role === "student" && q.authorKey === me.student.studentId.toLowerCase();
    if (me.role !== "teacher" && !(mine && !q.answer)) {
      return fail(403, "You can only delete your own unanswered questions");
    }

    var votes = await db.collection("upvotes").where("questionId", "==", qid).get();
    for (var i = 0; i < votes.docs.length; i++) {
      if (votes.docs[i].exists) await db.collection("upvotes").doc(votes.docs[i].id).delete();
    }
    await ref.delete();
    return reply(200, { ok: true });
  }

  // ---- students (teacher view) -----------------------------------------

  async function listStudents(db, me) {
    var students = await db.collection("students").get();
    var questions = await db.collection("questions").get();

    var counts = {};
    questions.docs.forEach(function (d) {
      if (!d.exists) return;
      var q = d.data();
      var c = counts[q.authorKey] || (counts[q.authorKey] = { asked: 0, answered: 0 });
      c.asked += 1;
      if (q.answer) c.answered += 1;
    });

    var rows = students.docs.filter(function (d) { return d.exists; }).map(function (d) {
      var s = d.data();
      var c = counts[d.id] || { asked: 0, answered: 0 };
      return {
        studentId: me.role === "teacher" ? s.studentId : undefined,
        name: s.name,
        createdAt: s.createdAt,
        questionCount: c.asked,
        answeredCount: c.answered
      };
    });
    rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return reply(200, rows);
  }

  async function removeStudent(db, me, studentId) {
    if (me.role !== "teacher") return fail(403, "Only the teacher can remove students");
    if (!STUDENT_ID_RE.test(studentId)) return reply(200, { ok: true });
    await db.collection("students").doc(studentId.toLowerCase()).delete();
    return reply(200, { ok: true });
  }

  // ---- router -----------------------------------------------------------

  async function handle(method, path, body) {
    var db = await getDb();
    if (!db) {
      return fail(503, "This class board needs you to be signed in to Claude. Sign in, then reload the page.");
    }

    var m;
    if (method === "POST" && path === "/students/join") return joinStudent(db, body);
    if (method === "POST" && path === "/students/login") return loginStudent(db, body);
    if (method === "POST" && path === "/teacher/login") return loginTeacher(db, body);
    if (method === "POST" && path === "/logout") {
      clearSession();
      return reply(200, { ok: true });
    }

    var session = readSession();
    var me = session && session.me;
    if (!me) return fail(401, "Please sign in again.");

    if (path === "/questions" && method === "GET") return listQuestions(db, me);
    if (path === "/questions" && method === "POST") return askQuestion(db, me, body);

    if ((m = path.match(/^\/questions\/([^/]+)\/(answer|upvote)$/)) && method === "POST") {
      var qid = safeDecode(m[1]);
      if (!DOC_ID_RE.test(qid)) return fail(404, "That question no longer exists");
      return m[2] === "answer" ? answerQuestion(db, me, qid, body) : toggleMeToo(db, me, qid);
    }
    if ((m = path.match(/^\/questions\/([^/]+)$/)) && method === "DELETE") {
      var did = safeDecode(m[1]);
      if (!DOC_ID_RE.test(did)) return reply(200, { ok: true });
      return deleteQuestion(db, me, did);
    }

    if (path === "/students" && method === "GET") return listStudents(db, me);
    if ((m = path.match(/^\/students\/([^/]+)$/)) && method === "DELETE") {
      return removeStudent(db, me, safeDecode(m[1]));
    }

    return fail(404, "Not found");
  }

  // ---- fetch override ---------------------------------------------------

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var at = url.indexOf("/api/");
    if (at < 0) return nativeFetch(input, init);

    var path = url.slice(at + 4).split("?")[0].replace(/\/+$/, "");
    var method = ((init && init.method) || "GET").toUpperCase();
    var body = {};
    if (init && typeof init.body === "string" && init.body) {
      try { body = JSON.parse(init.body) || {}; } catch (e) { body = {}; }
    }
    return handle(method, path, body).catch(function (err) {
      console.error("Class Q&A", err);
      return fail(500, "Something went wrong. Please try again.");
    });
  };
})();
