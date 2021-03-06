#!/usr/bin/env node

// For process spawning and configuration

const child_process = require("child_process");
const path = require("path");

// Task server is here for talking to task client inside process and for detecting failure. 

const task = require("./task");

// Default settings

const config = require("../config");

// This is for communicating to redis

const redis = require("workerjs-rabbitmq")({url: process.env.REDIS_URL || undefined});
let queue = redis.queue;

const w = {
	_task: task, // factory for new task server
	_restartCount: 0, // number of restarts of workers so far, for failure detection
	_limitReached: false, // this becomes true if restart count reached restart limit
	_workers: [], // list of spawned workers
	_readyWorkers: [], // list of workers that reported back as ready TODO: add timeout for worker to get online
	_taskCount: 0, // number of tasks currently running here
	_config: undefined, // Placeholder for config, it is added later in start function
	_stop: false, // This is set to true when worker is shutting down
	_listening: false,

	start: function(config){
		// lets get config and spawn workers and start listening
		
		queue.then((queueResolved) => {
			queue = queueResolved;

			w._config = config;

			for(let i = 0; i < config.get("WORKERCOUNT"); i++){
				w.fork();
			}
		});
	},

	listen: function(){
		// wait for task on queue

		queue.on(w._config.get("WORKERNAME"), function(data){
			// TODO: move JSON.parse to workerjs-redis

			if(typeof data == "string"){
				data = JSON.parse(data);
			}

			// Create task server for that task

			const task = w._task(data, w._config.get("WORKERNAME"));

			task.then((task) => {
				// Get worker for it and assign it

				let worker;
				if((!w._stop) && (worker = w.getNextWorker())){
					task.send(worker);
					w._taskCount++;

					if(w._taskCount >= w._readyWorkers.length * w._config.get("TASKLIMIT") && w._config.get("TASKLIMIT") > -1){
						if(queue.stop){
							queue.stop();
						}
					}

					task.on("failed", function(){
						w.finished();
					});
					
					task.on("finished", function(){
						w.finished();
					});
				} else {
					console.error("All workers busy... ");
					task.failed();
				}
			});
		});
	},

	finished: function(){
		if(!w._stop){
			w._taskCount--;
			if(queue.start !== undefined){
				queue.start();
			}
		}

		if(w._taskCount == 0 && w._stop){
			process.exit();
		}
	},

	getNextWorker: function(){
		// Find best process that fits config. Return false is none available

		let worker = false;

		const tempWorker = w.findWorker();

		if(!tempWorker){
			return false;
		}

		if(w._config.get("TASKLIMIT") == -1){
			worker = tempWorker;
		} else {
			if(tempWorker.tasks.length <= w._config.get("TASKLIMIT")){
				worker = tempWorker;
			}
		}

		return worker;
	},

	findWorker: function(){
		// Find process with least tasts

		let worker = w._readyWorkers[0];

		w._readyWorkers.forEach(function(currentWorker){
			if(currentWorker.tasks.length < worker.tasks.length){
				worker = currentWorker;
			}
		});

		return worker;
	},

	fork: function(number){
		const worker = child_process.fork(path.join(process.cwd(), w._config.get("WORKER")));

		if(number == undefined){
			number = w._workers.length + 1;
		}

		worker.tasks = [];
		worker.name = "Worker " + number;
		worker.number = number;

		w._workers.push(worker);

		worker.on("message", function(message){
			if(message.type == "ready"){
				w._readyWorkers.push(worker);

				if(!w._listening){
					w._listening = true;
					w.listen();
				}

				if(queue.start !== undefined){
					queue.start();
				}
			}
		});

		worker.on("exit", () => {
			// TODO: Handle exit reason
			w.exited(worker);
		});

		if(config.debug){
			console.log(worker.name + " started... ");
		}

		return worker;
	},

	exited: function(worker){
		worker.tasks.forEach(function(task){
			task.failed("error");

			w._taskCount--;
		});

		w._restartCount++;

		let name = "";
		let number = 0;

		w._workers = w._workers.filter(function(currentWorker){
			if(currentWorker == worker){
				name = worker.name;
				number = worker.number;
			}

			return currentWorker != worker;
		});

		w._readyWorker = w._readyWorkers.filter(function(currentWorker){
			return currentWorker != worker;
		});

		if(config.get("DEBUG")){
			console.log(name + " exited... ");
		}

		if(w._workers.length == 0){
			process.exit(0);
		}

		if(w._stop){
			return;
		}


		if(w._config.restartLimit != -1 && w._config.get("RESETLIMIT") <= w._restartCount){
			// TODO: Notify user

			if(!w._limitReached){
				if(config.get("DEBUG")){
					console.log("Restart limit reached... ");
				}
			}

			w._limitReached = true;

			if(w._workers.length == 0){
				process.exit(1);
			}

			return;
		}

		w.fork(number);
	}
};

w.start(config);

// Gracefull shutdown

process.stdin.resume();

function exitHandler(options, err) {
	w._stop = true;

	if (err) console.log(err.stack);
	if (options.exit) process.exit();
}

process.on("exit", exitHandler.bind(null,{cleanup:true}));
process.on("SIGINT", exitHandler.bind(null, {exit:false}));
process.on("uncaughtException", exitHandler.bind(null, {exit:false}));

