var settings = {
    mass: 1000,
    colour: { h:0, s:0, v:0.1 }
};

_mouseDown = false;
_rightClick = false;
_ctrlDown = false;
_clickX = 0;
_clickY = 0;
_currentX = 0;
_currentY = 0;

_planets = [];
_collisions = [];

_h = 1/75;
_initRadius = Math.log(Math.E + 1.0);

function eventResize() {
	_can.width = window.innerWidth;
	_can.height = window.innerHeight;
	_can.style.left = (window.innerWidth - _can.width) * .5 + 'px';
	_can.style.top = (window.innerHeight - _can.height) * .5 + 'px';
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

	if(_ctrlDown && _mouseDown) {
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
		addPlanet(_clickX, _clickY, vx, vy);
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
	_ctx.lineWidth = 2;
	_ctx.beginPath();
	_ctx.lineCap = "round";
	_ctx.moveTo(x1, y1);
	_ctx.lineTo(x2, y2);
	_ctx.strokeStyle = "#2299ff";
	_ctx.stroke();
}

function addPlanet(x, y, vx, vy) {
	_planets.push(new Planet(settings.mass, x, y, vx, vy));
}

function init() {
	_can = document.getElementById('can');
	_can.style.left="0px"
	_can.style.top="0px"
	_can.style.zIndex="0"
	_can.style.width="100%"
	_can.style.height="100%"
	_can.style.zIndex = 1;
	_can.width=_can.offsetWidth
	_can.height=_can.offsetHeight;

	_can.onmousemove = mouseMove;
	_can.onmousedown = mouseDown;
	_can.onmouseup = mouseUp;
	_can.oncontextmenu = rightClick;
	_can.onkeydown = keydown;
	_can.onkeyup = keyup;

	_ctx = _can.getContext('2d');

	_stats = document.getElementById('stats');

	run();
	setInterval(run, 25);
}

function stats() {
	_stats.innerHTML = _planets.length + " planets";
}

function run() {
	reDraw();
	drawVelocityLine();
	stats();
	integrate();
	for(var i = 0; i<_planets.length; i++) {
		updateVelocityAndPosition(_planets[i]);
	}
	for(var i = 0; i<_collisions.length; i++) {
		_planets.push(_collisions.pop());
	}
}

function reDraw() {
	_ctx.fillStyle = "rgba(42, 42, 42, .5)";
	_ctx.fillRect(0, 0, _can.width, _can.height);
	for(var i = 0; i<_planets.length; i++) {
		_planets[i].draw(_ctx);
	}
}

function integrate() {
	for(var j = 0; j<_planets.length; j++) {
		var p = _planets[j];
		var deltaAy = 0;
		var deltaAx = 0;
		for(var i = 0; i<_planets.length; i++) {
			var op = _planets[i];
			if(i != j && !p.collided && !op.collided) {
				var xdiff = (op.x-p.x);
				var ydiff = (op.y-p.y);
				var dsquared = (xdiff*xdiff)+(ydiff*ydiff);
				var d = Math.sqrt(dsquared);
				if(d < op.r + p.r) {
					op.collided = true;
					p.collided = true;
					var totalMass = op.m+p.m;
					_collisions.push(new Planet(totalMass, (op.x*op.m + p.x*p.m)/totalMass, (op.y*op.m + p.y*p.m)/totalMass, (op.vx*op.m + p.vx*p.m)/totalMass, (op.vy*op.m + p.vy*p.m)/totalMass));
				} else {
					var accel = op.m/dsquared;
					deltaAx += (accel*xdiff)/d;
					deltaAy += (accel*ydiff)/d;
				}
			}
		}
		p.ax = deltaAx;
		p.ay = deltaAy;
	}
}

function updateVelocityAndPosition(p) {
	if(p.collided) {
		_planets.splice(_planets.indexOf(p), 1);
	}
	p.vx += p.ax*_h;
	p.vy += p.ay*_h;
	p.x += p.vx*_h;
	p.y += p.vy*_h;
}

function distanceSquared(p1, p2) {
	var xdiff = (p2.x-p1.x);
	var ydiff = (p2.y-p1.y);
	return (xdiff*xdiff)+(ydiff*ydiff);
}

function Planet(pm, px, py, pvx, pvy) {
	this.m = pm;
	this.r = Math.log(Math.E + pm/settings.mass);
	this.getColor = function() {
		return "rgb(187, 187, 153)";
	}
	this.x = px;
	this.y = py;
	this.vx = pvx;
	this.vy = pvy;
	this.ax = 0;
	this.ay = 0;
	this.collided = false;
}

Planet.prototype = {
    draw: function( ctx ) {
    	ctx.beginPath();
		ctx.arc(this.x, this.y, this.r, 0, 2*Math.PI, 0);
		ctx.fillStyle = this.getColor();
		ctx.fill();
    }
};

function system(ix, iy, ivx, ivy) {
	var sign = (Math.random()>0.5)?1:-1;
	for(var i = 0; i<500; i++) {
		var dd = Math.min(_can.width, _can.height);
		var r = Math.random()*dd/2;
		var theta = Math.random()*Math.PI*2;
		var x = r*Math.cos(theta);
		var y = r*Math.sin(theta);

		var v = Math.random()*10 + 0.5*r;
		var vx = v*Math.cos(theta+(Math.PI*sign/2));
		var vy = v*Math.sin(theta+(Math.PI*sign/2));

		_planets.push(new Planet((settings.mass)*Math.random()*10, ix+x, iy+y, vx+ivx, vy+ivy));
	}
	_planets.push(new Planet((settings.mass)*10000, ix, iy, ivx, ivy));
}


window.addEventListener('resize', eventResize, false);
window.onload = init;

