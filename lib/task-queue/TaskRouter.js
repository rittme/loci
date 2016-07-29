/* globals Task */
"use strict";

const {Cu} = require("chrome");
const {WorkerTask} = require("lib/task-queue/WorkerTask");
const {Storage} = require("lib/task-queue/Storage");
const {Page} = require("lib/task-queue/Page");

Cu.import("resource://gre/modules/Task.jsm");

// The lock for page and task creation test-and-set
let taskCreationLock = false;
// The queue for messages waiting to be processed
const mutexQueue = [];

class TaskRouter {
  /**
   * Creates a new task router from a map of messages to TaskProcessor arrays
   *
   * @param {Map<string, TaskProcessor[]>} processorMap
   *                                       A map of Task Processors arrays for each message
   */
  constructor(processorMap) {
    if (!processorMap) {
      throw new Error("TaskRouter needs a map as argument.");
    }
    // Initialize task processors
    this.routes = processorMap;
  }

  /**
   * Check if the page should be processed by the queue
   *
   * @param {String}    url
   *                    The URL of the page we want to check
   * @returns {Promise}
   *                    Returns true if the page should be processed, false otherwise
   */
  asyncNeedProcessing(url) {
    return Task.spawn((function*() {
      console.log("Needs processing?");
      // Do we already have a task for this url?
      const tasks = yield WorkerTask.asyncGetByUrl(url);
      if (tasks) {
        console.log("We already have tasks");
        return false;
      }

      // Do we already have a page for this url?
      const page = yield Page.asyncGetByUrl(url);
      if (!page) {
        console.log("No page for it, let's roll.");
        return true;
      }

      // Is the page still valid?
      if (page.expiration > Date.now()) {
        console.log("page not expired.");
        return false;
      }

      // Do we have a DOM file for this page?
      const file = yield Storage.asyncGetFile(page.path);
      if (!file) {
        console.log("couldn't find the page file.");
        return false;
      }

      console.log("All good. Let's roll.");
      return true;
    }).bind(this));
  }

  /**
   * Create the worker tasks for a given message
   *
   * @param {Object} message
   *                 The message we want to create the tasks for
   */
  asyncCreateTasks(message) {
    return Task.spawn((function*() {
      // If someone is already working on the critic section, wait to be executed later
      if (taskCreationLock) {
        mutexQueue.push(message);
        console.log("function locked. Enqueued.");
        return;
      }
      console.log("Working on:");
      console.log(message);
      taskCreationLock = true;
      console.log("got lock");

      const needsProcessing = yield this.asyncNeedProcessing(message.data.url);
      if (needsProcessing) {
        console.log("Needs processing");
        const page = new Page({url: message.data.url});
        yield page.save();
        console.log("saved page");
        // Writes the DOM string to the file system
        yield Storage.asyncSaveFile(page.path, message.data.data);
        console.log("created file");
        // Create tasks and enqueue them
        const promises = this.routes.get(message.type).map((processor)=> {
          const task = new WorkerTask(message.data.url, processor.taskType);
          console.log("created task");
          console.log(task);
          return task.save().then(()=> {
            console.log("enqueing task");
            console.log(task);
            return processor.enqueue(task);
          });
        });

        // Wait for every task to be created
        yield Promise.all(promises);
        console.log("all task creation promisses done");
      }

      // Free the lock and call any waiting function
      taskCreationLock = false;
      console.log("handing key");
      if (mutexQueue.length) {
        this.asyncCreateTasks(mutexQueue.pop());
      }
    }).bind(this));
  }

  /**
   * Message handling and routing
   *
   * @param {Object} message
   *                 A message to be routed
   *                 - type: {String} the message type
   *                 - data {Object}
   *                   - url: {String} the page url
   *                   - data: {String} the page DOM content
   */
  handleMessage(message) {
    if (!message.type) {
      throw new Error("Worker queue messages should contain a type.");
    }

    if (!this.routes.has(message.type)) {
      throw new Error(`No route defined for message of type: ${message.type}`);
    }
    console.log("handling message");
    console.log(message);
    this.asyncCreateTasks(message);
  }
}

exports.TaskRouter = TaskRouter;
