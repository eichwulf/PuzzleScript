//monkey-patch compile

//Put a branch here for idempotence sake
if(!this.hasOwnProperty("compileAndAnalyze") ||
	 !this.compileAndAnalyze) {
	console.log("patch compile");
	var justCompile = compile;
	var compileAndAnalyze = function(command,text,randomSeed) {
		justCompile(command,text,randomSeed);
		Analyzer.analyze(command,text,randomSeed);
	}
	compile = compileAndAnalyze;
}

//TODO: show visual feedback in console or something when solvers are active.
//TODO: indicate search status in editor rather than in console.

var Analyzer = (function() {
	var module = {};
	var lastRules = "";
	var gameRules = "";
	var levelQueue = [];
	var seenSolutions = {};
	
	var USE_WORKERS = true;
	var INPUT_MAPPING = {};
	INPUT_MAPPING[-1]="WAIT";
	INPUT_MAPPING[0]="UP";
	INPUT_MAPPING[1]="LEFT";
	INPUT_MAPPING[2]="DOWN";
	INPUT_MAPPING[3]="RIGHT";
	INPUT_MAPPING[4]="ACT";

	//Launch a web worker to do analysis without blocking the UI.
	module.analyze = function(command,text,randomseed) {
		//by this time, compile has already been called.
		if(errorCount > 0) {
			consolePrint("Analysis cancelled due to errors.");
			return;
		}
		if (!text){
			var code = window.form1.code;
			var editor = code.editorreference;
			text = editor.getValue()+"\n";
		}
		gameRules = text;
		console.log("analyze "+command+" with "+randomseed+" in "+curlevel);
		if(gameRules != lastRules) {
			var solvers = getAllWorkers("solve");
			//TODO: if this is a different game, nuke seenSolutions
			//kill stale workers.
			//TODO: only kill them if their levels' texts have changed or if the rules have changed.
			levelQueue = [];
			for(var i = 0; i < solvers.length; i++) {
				killWorker("solve", solvers[i].key);
			}
			levelQueue = createLevelQueue(true, [curlevel]);
			tickLevelQueue(null);
			lastRules = gameRules;
		} else {
			consolePrint("Rules are unchanged. Skipping analysis.");
		}
	}
	
	function rulePart(rules) {
		return rules.substring(0,rules.search(/\bLEVELS\b/));
	}
	
	function equivLevels(l1, l2) {
		if(l1 == l2) { return true; }
		if(!l1 && l2) { return false; }
		if(l1 && !l2) { return false; }
		if(l1.objects && !l2.objects) { return false; }
		if(!l1.objects && l2.objects) { return false; }
		if(!l1.objects && !l2.objects) { return l1.message == l2.message; }
		if(l1.width != l2.width || l1.height != l2.height || l1.objects.length != l2.objects.length) { return false; }
		for(var i=0; i < l1.objects.length; i++) {
			if(l1.objects[i] != l2.objects[i]) { 
				return false; 
			}
		}
		return true;
	}
	
	function equivRules(oldRules, newRules) {
		return oldRules == newRules;
	}
	
	function enqueueLevel(q,lev,force) {
		var prevLevel = seenSolutions[lev] ? seenSolutions[lev].level : null;
		var prevRules = seenSolutions[lev] ? seenSolutions[lev].ruleText : null;
		if(equivLevels(prevLevel, state.levels[lev]) && equivRules(rulePart(prevRules), rulePart(gameRules))) {
		  consolePrint("Level "+lev+" seems unchanged");
		  return;
		}
		q.push(lev);
	}
	
	function createLevelQueue(force, prioritize) {
		//TODO: permit "clearing" default hints.
		var q = [];
		for(var i = 0; i < prioritize.length; i++) {
			if(state.levels[prioritize[i]] && !state.levels[prioritize[i]].message) {
				enqueueLevel(q,prioritize[i],force);
			}
		}
		for(i = 0; i < state.levels.length; i++) {
			if(q.indexOf(i) == -1 && state.levels[i] && !state.levels[i].message) {
				enqueueLevel(q,i,force);
			}
		}
		//assert(every_element_unique(q))
		return q;
	}
	
	function levelHint(lev) {
		return seenSolutions[lev] && seenSolutions[lev].prefixes && seenSolutions[lev].prefixes.length ? seenSolutions[lev] : null
	}
	
	//TODO: try running two or three workers at once.
	function tickLevelQueue(wkr) {
		if(!levelQueue.length) { return; }
		var lev = levelQueue.shift();
		var level = state.levels[lev];
		if(USE_WORKERS) {
			startWorker("solve", lev, {
				rules:gameRules,
				level:lev,
				//seed:randomseed,
				hint:levelHint(lev),
				verbose:true
			}, handleSolver, tickLevelQueue);
		} else {
			Solver.startSearch({
				rules:gameRules,
				level:lev,
				hint:levelHint(lev),
				//seed:randomseed,
				verbose:true,
				replyFn:function(type,msg) {
					console.log("MSG:"+type+":"+JSON.stringify(msg));
					switch(type) {
						case "busy":
							setTimeout(function() {
								Solver.continueSearch(msg.continuation);
							}, 10);
							break;
						case "stopped":
							tickLevelQueue(null);
							break;
						default:
							handleSolver(lev,type,msg);
							break;
					}
				}
			});
		}
	}
	
	function prefixToSolutionSteps(p) {
		return p.map(
			function(d){return INPUT_MAPPING[d];}
		);
	}
	
	function handleSolver(id,type,data) {
		switch(type) {
			case "solution":
				consolePrint("Level "+data.level+": Found solution #"+1+" (n"+data.solution.id+") of first-found cost "+data.solution.prefixes[0].length+" at iteration "+data.iteration+":<br/>&nbsp;"+data.solution.prefixes.map(function(p) { return prefixToSolutionSteps(p).join(","); }).join("<br/>&nbsp;"));
				if(data.iteration == 0) {
					consolePrint("&nbsp;(Thanks to hint from last time)");
				}
				recordSolution(workers[id].init.rules, workers[id].init.levelText, data);
				consoleCacheDump();
				break;
			case "exhausted":
				consolePrint("Level "+data.level+": Did not find more solutions after "+data.iterations+" iterations");
				if(!seenSolutions[data.level]) {
					recordFailure(workers[id].init.rules, workers[id].init.levelText, data);
				}
				break;
			case "hintInsufficient":
				consolePrint("Level "+data.level+": Hint did not solve level on its own.");
				break;
			default:
				break;
		}
	}
	
	function recordSolution(ruleText, levelText, data) {
		var level = data.level;
		var soln = data.solution;
		seenSolutions[level] = {
			ruleText:ruleText,
			levelText:levelText,
			level:state.levels[level],
			prefixes:soln.prefixes,
			steps:soln.prefixes.map(prefixToSolutionSteps),
			iteration:data.iteration,
			f:soln.f, g:soln.g, h:soln.h
		};
		return seenSolutions[level];
	}

	function recordFailure(ruleText, levelText, data) {
		var level = data.level;
		seenSolutions[level] = {
			ruleText:ruleText,
			levelText:levelText,
			level:state.levels[level],
			prefixes:[],
			steps:[],
			iteration:data.iteration,
			f:-1, g:-1, h:-1
		};
		return seenSolutions[level];
	}

	var workers = [];
	var workerLookup = {};
	var workerScripts = {
		"solve": "js/analyzer/worker_solve.js"
	};

	function killWorker(type,key) {
		console.log("KILL: "+type+" . "+key);
		var w = getWorker(type,key,false);
		if(!w) { return null; }
		w.terminate();
		workers[w.id] = null;
		delete workerLookup[type][key];
		return w;
	}

	function getWorker(type,key,require) {
		if(require === undefined) { require = true; }
		if(!workerLookup[type]) {
			if(require) {
				error("Unknown worker type "+type);
			}
			return null;
		}
		if(workerLookup[type] && !workerLookup[type][key]) {
			notify(require ? "error" : "warning",
						 "Unknown worker "+type+" : "+key);
			return null;
		}
		return workerLookup[type][key];
	}

	function getAllWorkers(type) {
		if(!workerLookup[type]) {
			return [];
		}
		var result = [];
		for(var k in workerLookup[type]) {
			result.push(workerLookup[type][k]);
		}
		return result;
	}
	
	function startWorker(wtype, key, init, handle, whenFinished) {
		var solutions = 0;
		if(getWorker(wtype,key,false)) {
			error("Can't start duplicate worker "+wtype+" : "+key)
		}
		var w = new Worker(workerScripts[wtype]);
		log("Created worker "+w);
		if(!workerLookup[wtype]) {
			workerLookup[wtype] = {};
		}
		workerLookup[wtype][key] = w;
		w.workerType = wtype;
		w.key = key;
		w.init = init;

		w.onmessage = function(msg) {
			var type = msg.data.type;
			var data = msg.data.message;
			var id = msg.data.id;
			console.log("got "+type+":"+JSON.stringify(data));
			switch(type) {
				case "message":
					console.log(""+data.severity + ":" + JSON.stringify(data.message));
					break;
				case "busy":
					workers[id].postMessage({
						type:"resume",
						continuation:data.continuation
					});
					break;
				case "stopped":
					whenFinished(w);
					killWorker(wtype,key);
					break;
				default:
					handle(id,type,data);
					break;
			}
		};
		w.onerror = function(event) {
			killWorker(wtype,key);
			throw new Error(event.message + " (" + event.filename + ":" + event.lineno + ")");
		}

		w.postMessage({type:"start",
			           id:workers.length,
			           workerType:wtype,
			           key:key,
			           init:init});
		log("sent init message");
		workers.push(w);

		return w;
	};

	return module;
})();

function error(msg) {
	notify("error", msg);
	throw new Error(msg);
}

function warn(msg) {
	notify("warning", msg);
}

function log(msg) {
	notify("info", msg);
}

function notify(severity, msg) {
	console.log(severity+":"+msg);
}
