_integrationValues = [ 'Runge Kutta 4', 'Euler', 'Verlet (todo)' ];
_minMass = 1000;
_maxMass = 100000;

var settings = {
    mass: 4000,
    color: "#bbbb99",
    trailOpacity: .24,
    timeStep: 1/75,
    integration: _integrationValues[0],
    barnesHut: false,
    collisions: true,
    clear: function() {
    	_doClear = true;
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

	if(_ctrlDown && !_mouseDown) {
		for(var i = 0; i<_planets.length; i++) {
			_planets[i].x = _planets[i].x + (_currentX-oldX);
			_planets[i].y = _planets[i].y + (_currentY-oldY);
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
		_planets.push(new Planet(settings.mass, _clickX, _clickY, vx, vy));
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
	gui.add(settings, 'clear');
	gui.add(settings, 'mass', _minMass, _maxMass).step(1000);
	gui.addColor(settings, 'color');
	gui.add(settings, 'trailOpacity', 0.0, 1.0).step(.01);
	gui.add(settings, 'timeStep', 1/250, 1/5);
	gui.add(settings, 'integration', _integrationValues);
	gui.add(settings, 'collisions');
	//gui.add(settings, 'barnesHut');

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
	_blurb.style.color = settings.color;
}

function run() {
	reDraw();
	drawVelocityLine();
	stats();

	_prevPlanets = _planets.slice();
	for(var j = 0; j<_planets.length; j++) {
		takeStep(j);
	}
	// collisions
	if(settings.collisions) {
		for(var j = 0; j<_planets.length; j++) {
			var p = _planets[j];
			for(var i = j+1; i<_planets.length; i++) {
				var op = _planets[i];
				if(!p.collided && !op.collided) {
					var xdiff = (op.x-p.x);
					var ydiff = (op.y-p.y);
					var dsquared = (xdiff*xdiff)+(ydiff*ydiff);
					var d = Math.sqrt(dsquared);
					if(d < op.r + p.r) {
						op.collided = true;
						p.collided = true;
						var totalMass = op.m+p.m;
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
	}

	var thisLoop = new Date();
	var thisFrameTime = thisLoop - _lastLoop;
	_frameTime += (thisFrameTime - _frameTime) / 20.0;
	_lastLoop = thisLoop;
}

function reDraw() {
	_ctxbak.clearRect(0, 0, _can.width, _can.height);
	var alpha = settings.trailOpacity;
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

function nsquaredacceleration(j, x, y) {
	var deltaAx = 0;
	var deltaAy = 0;
	for(var i = 0; i<_prevPlanets.length; i++) {
		var op = _prevPlanets[i];
		if(i != j) {
			var xdiff = (op.x-x);
			var ydiff = (op.y-y);
			var dsquared = (xdiff*xdiff)+(ydiff*ydiff);
			var d = Math.max(Math.sqrt(dsquared), 1.8);
			
			var accel = op.m/dsquared;
			deltaAx += (accel*xdiff)/d;
			deltaAy += (accel*ydiff)/d;
		}
	}
	return [ deltaAx, deltaAy ];
}

function takeStep(j) {
	var p = _planets[j];
	var pp = _prevPlanets[j];
	var ppx = pp.x;
	var ppy = pp.y;
	var ppvx = pp.vx;
	var ppvy = pp.vy;
	var h = settings.timeStep;
	// euler
	if(settings.integration == _integrationValues[1]) {
		var a = nsquaredacceleration(j, ppx, ppy);
		p.vx += a[0]*h;
		p.vy += a[1]*h;
		p.x += p.vx*h;
		p.y += p.vy*h;
	} else if(settings.integration == _integrationValues[0]) { // rk4
		var x1 = ppx;
		var y1 = ppy;
		var vx1 = ppvx;
		var vy1 = ppvy;
		var a1 = nsquaredacceleration(j, x1, y1);

		var x2 = ppx + 0.5*vx1*h;
		var y2 = ppy + 0.5*vy1*h;
		var vx2 = ppvx + 0.5*a1[0]*h;
		var vy2 = ppvy + 0.5*a1[1]*h;
		var a2 = nsquaredacceleration(j, x2, y2);

		var x3 = ppx + 0.5*vx2*h;
		var y3 = ppy + 0.5*vy2*h;
		var vx3 = ppvx + 0.5*a2[0]*h;
		var vy3 = ppvy + 0.5*a2[1]*h;
		var a3 = nsquaredacceleration(j, x3, y3);

		var x4 = ppx + vx3*h;
		var y4 = ppy + vy3*h;
		var vx4 = ppvx + a3[0]*h;
		var vy4 = ppvy + a3[1]*h;
		var a4 = nsquaredacceleration(j, x4, y4);

		p.vx += (h/6.0)*(a1[0] + 2.0*a2[0] + 2.0*a3[0] + a4[0]);
		p.vy += (h/6.0)*(a1[1] + 2.0*a2[1] + 2.0*a3[1] + a4[1]);

		p.x += (h/6.0)*(vx1 + 2.0*vx2 + 2.0*vx3 + vx4);
		p.y += (h/6.0)*(vy1 + 2.0*vy2 + 2.0*vy3 + vy4);
	} else if(settings.integration == _integrationValues[1]) { // verlet
		// todo
	}
}

function distanceSquared(p1, p2) {
	var xdiff = (p2.x-p1.x);
	var ydiff = (p2.y-p1.y);
	return (xdiff*xdiff)+(ydiff*ydiff);
}

function Planet(pm, px, py, pvx, pvy, color) {
	this.m = pm;
	this.r = Math.log(Math.E + pm/_minMass);
	if(typeof(color)==='undefined') {
		this.color = settings.color;
	} else {
		this.color = color;
	}
	this.x = px;
	this.y = py;
	this.vx = pvx;
	this.vy = pvy;
	this.collided = false;

	this.draw = function( ctx ) {
    	ctx.beginPath();
		ctx.arc(this.x, this.y, this.r, 0, 2*Math.PI, 0);
		ctx.fillStyle = this.color;
		ctx.fill();
    }
}

function system(ix, iy, ivx, ivy) {
	var sign = (Math.random()>0.5)?1:-1;
	for(var i = 0; i<500; i++) {
		var dd = Math.min(_can.width, _can.height);
		var r = Math.random()*dd/2;
		var theta = Math.random()*Math.PI*2;
		var x = r*Math.cos(theta);
		var y = r*Math.sin(theta);

		var m = settings.mass + ((Math.random()*2)-1)*(settings.mass/5.0);
		var v = Math.min((2800.0*Math.pow(r, -1.0/2.0) + 30)+Math.pow((m/_minMass)*1.3, 2.6), 1000.00);
		var vx = v*Math.cos(theta+(Math.PI*sign/2));
		var vy = v*Math.sin(theta+(Math.PI*sign/2));

		_planets.push(new Planet(m, ix+x, iy+y, vx+ivx, vy+ivy));
	}
	_planets.push(new Planet((settings.mass)*8000, ix, iy, ivx, ivy));
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

