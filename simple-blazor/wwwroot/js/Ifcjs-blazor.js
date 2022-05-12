import {
    AmbientLight,
    AxesHelper,
    GridHelper,
    PerspectiveCamera,
    Scene,
    WebGLRenderer,
    PointLight
} from '../js/three.module.js';
import { OrbitControls } from '../js/OrbitControls.js';
import { IFCLoader } from "../js/web-ifc-three.js";

var container, controls;
var camera, scene, renderer;
const ifcLoader = new IFCLoader();

function animate() {
    requestAnimationFrame(animate);
    render();
}

function render() {

    renderer.render(scene, camera);
}

function loadScene() {

    container = document.getElementById('threejscontainer');
    if (!container) {
        return;
    }

    scene = new Scene();

    camera = new PerspectiveCamera(25, container.clientWidth / container.clientHeight, 1, 1000);
    camera.position.set(15, 10, - 15);

    var gridHelper = new GridHelper(10, 20);
    scene.add(gridHelper);

    var ambientLight = new AmbientLight(0xffffff, 0.2);
    scene.add(ambientLight);

    var pointLight = new PointLight(0xffffff, 0.8);
    scene.add(camera);
    camera.add(pointLight);

    renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);

    while (container.lastElementChild) {
        container.removeChild(container.lastElementChild);
    }

    container.appendChild(renderer.domElement);

    const axes = new AxesHelper();
    axes.material.depthTest = false;
    axes.renderOrder = 1;
    scene.add(axes);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.screenSpacePanning = true;
    controls.minDistance = 5;
    controls.maxDistance = 400;
    controls.target.set(0, 2, 0);
    controls.update();

    animate();


}

function addListeners() {
    const input = document.getElementById("file-input");
    input.addEventListener(
        "change",
        (changed) => {
            const file = changed.target.files[0];
            var ifcURL = URL.createObjectURL(file);
            ifcLoader.load(
                ifcURL,
                (ifcModel) => scene.add(ifcModel));
        },
        false
    );

    //Adjust the viewport to the size of the browser
    window.addEventListener("resize", () => {
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    });
}

window.Ifcjs_blazor = {
    load: () => { loadScene(); },
    listen: () => { addListeners(); },
};

