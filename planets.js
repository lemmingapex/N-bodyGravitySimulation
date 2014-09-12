_integrationValues = [ 'Runge Kutta 4', 'Euler', 'Verlet' ];
_collisionValues = [ 'Combine', 'Bounce', 'None' ];
_minMass = 1000;
_maxMass = 100000;

_settings = {
	mass: 4000,
	color: "#bbbb99",
	trailOpacity: .24,
	timeStep: 1/75,
	integration: _integrationValues[0],
	barnesHut: false,
	collisions: _collisionValues[0],
	damping: 0,
	clear: function() {
		_doClear = true;
	},
	reset: function() {
		_settings.mass = 4000;
		_settings.color = "#bbbb99";
		_settings.trailOpacity = .24;
		_settings.timeStep = 1/75;
		_settings.integration = _integrationValues[0];
		_settings.barnesHut = false;
		_settings.collisions = _collisionValues[0];
		_settings.damping = 0;
	}
};

_doClear = false;
_mouseDown = false;
_rightClick = false;
_ctrlDown = false;
_clickX = 0;
_clickY = 0;
_currentX = 0;
_currentY = 0;

_planets = [];
_collisions = [];

_initRadius = Math.log(Math.E + 1.0);

function eventResize() {
	_can.width = window.innerWidth;
	_can.height = window.innerHeight;
	_can.style.left = (window.innerWidth - _can.width) * .5 + 'px';
	_can.style.top = (window.innerHeight - _can.height) * .5 + 'px';

	_canbak.width = window.innerWidth;
	_canbak.height = window.innerHeight;
	_canbak.style.left = (window.innerWidth - _canbak.width) * .5 + 'px';
	_canbak.style.top = (window.innerHeight - _canbak.height) * .5 + 'px';
}

function drawVelocityLine() {
	if(_mouseDown) {
		drawLine(_clickX, _clickY, _currentX, _currentY);
	}
}

function mouseDown(e) {
	_mouseDown = true;
	_clickX = e.layerX-_initRadius;
	_clickY = e.layerY-_initRadius;
}

function mouseMove(e) {
	var oldX = _currentX;
	var oldY = _currentY;
	_currentX = e.clientX - _can.offsetLeft;
	_currentY = e.clientY - _can.offsetTop;

	var xdiff = (_currentX-oldX);
	var ydiff = (_currentY-oldY);
	if(_ctrlDown && !_mouseDown) {
		for(var i = 0; i<_planets.length; i++) {
			_planets[i].x += xdiff;
			_planets[i].ox +=  xdiff;
			_planets[i].y += ydiff;
			_planets[i].oy += ydiff;
		}
	}
}

function mouseUp(e) {
	var vx = (e.layerX-_initRadius)-_clickX;
	var vy = (e.layerY-_initRadius)-_clickY;

	if(_rightClick) {
		_rightClick = false;
		_mouseDown = false;
		system(_clickX, _clickY, vx, vy);
	} else {
		_rightClick = false;
		_mouseDown = false;
		_planets.push(new Planet(_settings.mass, _clickX, _clickY, vx, vy));
	}

}

function rightClick(e) {
	_rightClick = true;
	return false;
}

function keydown(e) {
	if(e.keyCode == 17) {
		_ctrlDown = true;
	}
}

function keyup(e) {
	if(e.keyCode == 17) {
		_ctrlDown = false;
	}
}

function drawLine(x1, y1, x2, y2) {
	_ctxbak.lineWidth = 2;
	_ctxbak.beginPath();
	_ctxbak.lineCap = "round";
	_ctxbak.moveTo(x1, y1);
	_ctxbak.lineTo(x2, y2);
	_ctxbak.strokeStyle = "#2299ff";
	_ctxbak.stroke();
}

function init() {
	// gui
	var gui = new dat.GUI();
	gui.add(_settings, 'reset').name('Reset Controls');
	var newPlanetSettings = gui.addFolder('New Planet Settings');
	newPlanetSettings.add(_settings, 'mass', _minMass, _maxMass).step(1000).name('Mass').listen();
	newPlanetSettings.addColor(_settings, 'color').name('Color').listen();
	newPlanetSettings.open();
	var globalSettings = gui.addFolder('Global Settings');
	globalSettings.add(_settings, 'clear').name('Remove Planets').listen();
	globalSettings.add(_settings, 'trailOpacity', 0.0, 1.0).step(.01).name('Trail Opacity').listen();
	globalSettings.add(_settings, 'timeStep', 1/250, 1/5).name('Time Step').listen();
	globalSettings.add(_settings, 'integration', _integrationValues).name('Integration').listen();
	globalSettings.add(_settings, 'collisions', _collisionValues).name('Collisions').listen();
	globalSettings.add(_settings, 'damping', 0, 100).name('Damping').listen();
	//globalSettings.add(_settings, 'barnesHut').name('Barnes Hut?').listen();
	globalSettings.open();
	

	// background
	_canbak = document.getElementById('canbak');
	_canbak.style.left="0px";
	_canbak.style.top="0px";
	_canbak.style.width="100%";
	_canbak.style.height="100%";
	_canbak.style.zIndex = 1;
	_canbak.width=_canbak.offsetWidth;
	_canbak.height=_canbak.offsetHeight;
	_ctxbak = _canbak.getContext('2d');

	_can = document.getElementById('can');
	_can.style.left="0px";
	_can.style.top="0px";
	_can.style.width="100%";
	_can.style.height="100%";
	_can.style.zIndex = 0;
	_can.width=_can.offsetWidth;
	_can.height=_can.offsetHeight;

	_can.onmousemove = mouseMove;
	_can.onmousedown = mouseDown;
	_can.onmouseup = mouseUp;
	_can.oncontextmenu = rightClick;
	_can.onkeydown = keydown;
	_can.onkeyup = keyup;
	_can.onselectstart = function () { return false; };

	_ctx = _can.getContext('2d');

	_stats = document.getElementById('stats');
	_blurb = document.getElementById('blurb');

	_frameTime = 0;
	_lastLoop = new Date();
	var fpsOut = document.getElementById('fps');
	setInterval(function(){
		fpsOut.innerHTML = (1000/_frameTime).toFixed(1) + " fps";
	},1000);

	run();
	setInterval(run, 10);
}

function stats() {
	_stats.innerHTML = _planets.length + " planets";
}

function run() {
	reDraw();
	drawVelocityLine();
	stats();

	_prevPlanets = [];

	for(var j = 0; j<_planets.length; j++) {
		var p = _planets[j];
		_prevPlanets.push(new Planet(p.m, p.x, p.y, p.vx, p.vy, p.color));
	}

	for(var j = 0; j<_planets.length; j++) {
		takeStep(j);
	}
	// collisions
	if(_settings.collisions == _collisionValues[0]) {
		for(var j = 0; j<_planets.length; j++) {
			var p = _planets[j];
			for(var i = j+1; i<_planets.length; i++) {
				var op = _planets[i];
				if(!p.collided && !op.collided) {
					var xdiff = (op.x-p.x);
					var ydiff = (op.y-p.y);
					var d = Math.sqrt((xdiff*xdiff)+(ydiff*ydiff));
					if(d < op.r + p.r) {
						op.collided = true;
						p.collided = true;
						var totalMass = op.m+p.m;
						// combine the colors all nice like.
						var pc = hexToRgb(op.color);
						var opc = hexToRgb(p.color);
						var t = op.m/totalMass;
						var r = Math.floor(t*pc.r + (1-t)*opc.r);
						var g = Math.floor(t*pc.g + (1-t)*opc.g);
						var b = Math.floor(t*pc.b + (1-t)*opc.b);
						_collisions.push(new Planet(totalMass, (op.x*op.m + p.x*p.m)/totalMass, (op.y*op.m + p.y*p.m)/totalMass, (op.vx*op.m + p.vx*p.m)/totalMass, (op.vy*op.m + p.vy*p.m)/totalMass, rgbToHex(r,g,b)));
					}
				}
			}
		}

		for(var j = 0; j<_planets.length; j++) {
			var p = _planets[j];
			if(p.collided) {
				_planets.splice(j--, 1);
			}
		}

		for(var i = 0; i<_collisions.length; i++) {
			_planets.push(_collisions.pop());
		}
	} else if(_settings.collisions == _collisionValues[1]) {

		// javascript doesn't have a clone or deepcopy for objects.... great
		var _planetsCopy = [];

		for(var j = 0; j<_planets.length; j++) {
			var p = _planets[j];
			_planetsCopy.push(new Planet(p.m, p.x, p.y, p.vx, p.vy, p.color));
		}

		// runtime is poor, eh?
		for(var j = 0; j<_planets.length; j++) {
			var p = _planets[j];
			for(var i = 0; i<_planetsCopy.length; i++) {
				if(i == j) {
					continue;
				}
				var op = _planetsCopy[i];
				// need to normalize these later...
				var xdiff = (op.x-p.x);
				var ydiff = (op.y-p.y);
				var d = Math.sqrt((xdiff*xdiff)+(ydiff*ydiff));
				if(d < op.r + p.r) {
					// because of the double loop, the code inside this block is one-sided

					// Calculate relative velocity
					var vxdiff = op.vx - p.vx;
					var vydiff = op.vy - p.vy;

					// Calculate relative velocity in the normal direction
					// deltaV dot N
					var velAlongNormal = (vxdiff * (xdiff/d)) + (vydiff * (ydiff/d));

					// Do not resolve if velocities are separating
					if(velAlongNormal < 0) {
						// restitution, could be per planet
						var e = 0.9;

						// inverse mass is used all over the place...
						var pim = 1.0/p.m;
						var opim = 1.0/op.m;

						// calculate impulse scalar
						// derived from conservation of momentum and impulse along the collision normal
						// see http://gamedevelopment.tutsplus.com/tutorials/how-to-create-a-custom-2d-physics-engine-the-basics-and-impulse-resolution--gamedev-6331 for details
						var t = -1.0 * (1.0 + e) * velAlongNormal / (pim + opim);

						// find impulse
						var impulsex = t * (xdiff/d);
						var impulsey = t * (ydiff/d);

						// find new velocities
						var newpvx = p.vx - (pim * impulsex);
						var newpvy = p.vy - (pim * impulsey);
						p.vx = newpvx;
						p.vy = newpvy;

						var newopvx = op.vx + (opim * impulsex);
						var newopvy = op.vy + (opim * impulsey);

						// positional correction via linear projection due to floating point errors...  Stupid computers
						var penetration = op.r + p.r - d;
						var correctionPercentage = 0.25;
						var epsilon = 0.001;
						var correctionx = (Math.max(penetration - epsilon, 0.0) / (pim + opim)) * correctionPercentage * (xdiff/d);
						var correctiony = (Math.max(penetration - epsilon, 0.0) / (pim + opim)) * correctionPercentage * (ydiff/d);
						var newpx = p.x - pim*correctionx;
						p.x = newpx;
						var newpy = p.y - pim*correctiony;
						p.y = newpy;
						var newopx = op.x + opim*correctionx;
						var newopy = op.y + opim*correctiony;
					}
				}
			}
		}
	}

	var thisLoop = new Date();
	var thisFrameTime = thisLoop - _lastLoop;
	_frameTime += (thisFrameTime - _frameTime) / 20.0;
	_lastLoop = thisLoop;
}

function reDraw() {
	_ctxbak.clearRect(0, 0, _can.width, _can.height);
	var alpha = _settings.trailOpacity;
	if(_ctrlDown || _doClear) {
		alpha = 1.0;
	}
	if(_doClear) {
		_doClear = false;
		_planets = [];
		_collisions = [];
	}
	_ctx.fillStyle = "rgba(42, 42, 42, " + alpha + ")";
	_ctx.fillRect(0, 0, _can.width, _can.height);
	for(var i = 0; i<_planets.length; i++) {
		_planets[i].draw(_ctx);
	}
}

function nsquaredacceleration(j, x, y, r) {
	var deltaAx = 0;
	var deltaAy = 0;
	for(var i = 0; i<_prevPlanets.length; i++) {
		var op = _prevPlanets[i];
		if(i != j) {
			var xdiff = (op.x-x);
			var ydiff = (op.y-y);
			var d = Math.max(Math.sqrt((xdiff*xdiff)+(ydiff*ydiff)), r + op.r);
			
			var accel = op.m/(d*d);
			deltaAx += (accel*xdiff)/d;
			deltaAy += (accel*ydiff)/d;
		}
	}
	return [ deltaAx, deltaAy ];
}

function takeStep(j) {
	var p = _planets[j];
	var px = p.x;
	var py = p.y;
	var pp = _prevPlanets[j];
	var ppx = pp.x;
	var ppy = pp.y;
	var ppvx = pp.vx;
	var ppvy = pp.vy;
	var h = _settings.timeStep;
	var f = _settings.damping/2000;
	// euler
	if(_settings.integration == _integrationValues[1]) {
		var a = nsquaredacceleration(j, ppx, ppy, pp.r);
		p.vx = (1 - f)*p.vx + a[0]*h;
		p.vy = (1 - f)*p.vy + a[1]*h;
		p.x += p.vx*h;
		p.ox = px;
		p.y += p.vy*h;
		p.oy = py;
	} else if(_settings.integration == _integrationValues[0]) { // rk4
		var x1 = ppx;
		var y1 = ppy;
		var vx1 = (1 - f)*ppvx;
		var vy1 = (1 - f)*ppvy;
		var a1 = nsquaredacceleration(j, x1, y1, pp.r);

		var x2 = ppx + 0.5*vx1*h;
		var y2 = ppy + 0.5*vy1*h;
		var vx2 = (1 - f)*ppvx + 0.5*a1[0]*h;
		var vy2 = (1 - f)*ppvy + 0.5*a1[1]*h;
		var a2 = nsquaredacceleration(j, x2, y2, pp.r);

		var x3 = ppx + 0.5*vx2*h;
		var y3 = ppy + 0.5*vy2*h;
		var vx3 = (1 - f)*ppvx + 0.5*a2[0]*h;
		var vy3 = (1 - f)*ppvy + 0.5*a2[1]*h;
		var a3 = nsquaredacceleration(j, x3, y3, pp.r);

		var x4 = ppx + vx3*h;
		var y4 = ppy + vy3*h;
		var vx4 = (1 - f)*ppvx + a3[0]*h;
		var vy4 = (1 - f)*ppvy + a3[1]*h;
		var a4 = nsquaredacceleration(j, x4, y4, pp.r);

		p.vx = (1 - f)*p.vx + (h/6.0)*(a1[0] + 2.0*a2[0] + 2.0*a3[0] + a4[0]);
		p.vy = (1 - f)*p.vy + (h/6.0)*(a1[1] + 2.0*a2[1] + 2.0*a3[1] + a4[1]);

		p.x += (h/6.0)*(vx1 + 2.0*vx2 + 2.0*vx3 + vx4);
		p.ox = px;
		p.y += (h/6.0)*(vy1 + 2.0*vy2 + 2.0*vy3 + vy4);
		p.oy = py;
	} else if(_settings.integration == _integrationValues[2]) { // verlet
		var a = nsquaredacceleration(j, ppx, ppy, pp.r);
		if(p.isnew) {
			p.ox = p.x;
			p.x += (p.vx*h) + (0.5*a[0]*h*h);
			p.vx = (p.x - p.ox)/h;
			p.oy = p.y;
			p.y += (p.vy*h) + (0.5*a[1]*h*h);			
			p.vy = (p.y - p.oy)/h;

			p.isnew = false;
		} else {
			p.x = ((2 - f)*p.x - (1 - f)*p.ox) + a[0]*h*h;
			p.ox = px;
			p.vx = (p.x - p.ox)/h;
			p.y = ((2 - f)*p.y - (1 - f)*p.oy) + a[1]*h*h;
			p.oy = py;
			p.vy = (p.y - p.oy)/h;
		}
	}
}

function Planet(pm, px, py, pvx, pvy, color) {
	this.m = pm;
	this.r = Math.log(Math.E + pm/_minMass);
	if(typeof(color)==='undefined') {
		this.color = _settings.color;
	} else {
		this.color = color;
	}
	this.x = px;
	this.y = py;
	this.ox = 0;
	this.oy = 0;
	this.vx = pvx;
	this.vy = pvy;
	this.collided = false;
	this.isnew = true;

	this.draw = function( ctx ) {
    	ctx.beginPath();
		ctx.arc(this.x, this.y, this.r, 0, 2*Math.PI, 0);
		ctx.fillStyle = this.color;
		ctx.fill();
    }
}

function system(ix, iy, ivx, ivy) {
	var sign = (Math.random()>0.5)?1:-1;
	for(var i = 0; i<300; i++) {
		var dd = Math.min(_can.width, _can.height);
		var r = Math.random()*dd/2;
		var theta = Math.random()*Math.PI*2;
		var x = r*Math.cos(theta);
		var y = r*Math.sin(theta);

		var m = _settings.mass + ((Math.random()*2)-1)*(_settings.mass/4.0);
		var v = Math.min((2800.0*Math.pow(r, -1.0/2.0) + 30)+Math.pow((m/_minMass)*1.3, 2.6), 1000.00);
		var vx = v*Math.cos(theta+(Math.PI*sign/2));
		var vy = v*Math.sin(theta+(Math.PI*sign/2));

		_planets.push(new Planet(m, ix+x, iy+y, vx+ivx, vy+ivy));
	}
	_planets.push(new Planet((_settings.mass)*8000, ix, iy, ivx, ivy));
}

function hexToRgb(hex) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function componentToHex(c) {
    var hex = c.toString(16);
    return hex.length == 1 ? "0" + hex : hex;
}

function rgbToHex(r, g, b) {
    return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

window.addEventListener('resize', eventResize, false);
window.onload = init;

