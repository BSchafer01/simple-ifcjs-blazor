﻿import * as WebIFC from '../js/web-ifc.js';
import { IFCSPACE, IFCOPENINGELEMENT, IFCPRODUCTDEFINITIONSHAPE, IFCRELAGGREGATES, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYPROPERTIES, IFCRELASSOCIATESMATERIAL, IFCRELDEFINESBYTYPE, IFCPROJECT } from '../js/web-ifc.js';
import { Mesh, Color, MeshLambertMaterial, DoubleSide, Matrix4, BufferGeometry, BufferAttribute, Loader, FileLoader } from '../js/three.module.js';
import { mergeBufferGeometries } from '../js/BufferGeometryUtils.js';

const nullIfcManagerErrorMessage = 'IfcManager is null!';

class IFCModel extends Mesh {

    constructor() {
        super(...arguments);
        this.modelID = IFCModel.modelIdCounter++;
        this.ifcManager = null;
        this.mesh = this;
    }

    static dispose() {
        IFCModel.modelIdCounter = 0;
    }

    setIFCManager(manager) {
        this.ifcManager = manager;
    }

    setWasmPath(path) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        this.ifcManager.setWasmPath(path);
    }

    close(scene) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        this.ifcManager.close(this.modelID, scene);
    }

    getExpressId(geometry, faceIndex) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getExpressId(geometry, faceIndex);
    }

    getAllItemsOfType(type, verbose) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getAllItemsOfType(this.modelID, type, verbose);
    }

    getItemProperties(id, recursive = false) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getItemProperties(this.modelID, id, recursive);
    }

    getPropertySets(id, recursive = false) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getPropertySets(this.modelID, id, recursive);
    }

    getTypeProperties(id, recursive = false) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getTypeProperties(this.modelID, id, recursive);
    }

    getIfcType(id) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getIfcType(this.modelID, id);
    }

    getSpatialStructure() {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getSpatialStructure(this.modelID);
    }

    getSubset(material) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        return this.ifcManager.getSubset(this.modelID, material);
    }

    removeSubset(material, customID) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        this.ifcManager.removeSubset(this.modelID, material, customID);
    }

    createSubset(config) {
        if (this.ifcManager === null)
            throw new Error(nullIfcManagerErrorMessage);
        const modelConfig = {
            ...config,
            modelID: this.modelID
        };
        return this.ifcManager.createSubset(modelConfig);
    }

}

IFCModel.modelIdCounter = 0;

class IFCParser {

    constructor(state, BVH) {
        this.state = state;
        this.BVH = BVH;
        this.loadedModels = 0;
        this.optionalCategories = {
            [IFCSPACE]: true,
            [IFCOPENINGELEMENT]: false
        };
        this.geometriesByMaterials = {};
        this.loadingState = {
            total: 0,
            current: 0,
            step: 0.1
        };
        this.currentWebIfcID = -1;
        this.currentModelID = -1;
    }

    async setupOptionalCategories(config) {
        this.optionalCategories = config;
    }

    async parse(buffer, coordinationMatrix) {
        if (this.state.api.wasmModule === undefined)
            await this.state.api.Init();
        await this.newIfcModel(buffer);
        this.loadedModels++;
        if (coordinationMatrix) {
            await this.state.api.SetGeometryTransformation(this.currentWebIfcID, coordinationMatrix);
        }
        return this.loadAllGeometry(this.currentWebIfcID);
    }

    getAndClearErrors(_modelId) { }

    notifyProgress(loaded, total) {
        if (this.state.onProgress)
            this.state.onProgress({
                loaded,
                total
            });
    }

    async newIfcModel(buffer) {
        const data = new Uint8Array(buffer);
        this.currentWebIfcID = await this.state.api.OpenModel(data, this.state.webIfcSettings);
        this.currentModelID = this.state.useJSON ? this.loadedModels : this.currentWebIfcID;
        this.state.models[this.currentModelID] = {
            modelID: this.currentModelID,
            mesh: {},
            types: {},
            jsonData: {}
        };
    }

    async loadAllGeometry(modelID) {
        this.addOptionalCategories(modelID);
        await this.initializeLoadingState(modelID);
        this.state.api.StreamAllMeshes(modelID, (mesh) => {
            this.updateLoadingState();
            this.streamMesh(modelID, mesh);
        });
        this.notifyLoadingEnded();
        const geometries = [];
        const materials = [];
        Object.keys(this.geometriesByMaterials).forEach((key) => {
            const geometriesByMaterial = this.geometriesByMaterials[key].geometries;
            const merged = mergeBufferGeometries(geometriesByMaterial);
            materials.push(this.geometriesByMaterials[key].material);
            geometries.push(merged);
        });
        const combinedGeometry = mergeBufferGeometries(geometries, true);
        this.cleanUpGeometryMemory(geometries);
        if (this.BVH)
            this.BVH.applyThreeMeshBVH(combinedGeometry);
        const model = new IFCModel(combinedGeometry, materials);
        this.state.models[this.currentModelID].mesh = model;
        return model;
    }

    async initializeLoadingState(modelID) {
        const shapes = await this.state.api.GetLineIDsWithType(modelID, IFCPRODUCTDEFINITIONSHAPE);
        this.loadingState.total = shapes.size();
        this.loadingState.current = 0;
        this.loadingState.step = 0.1;
    }

    notifyLoadingEnded() {
        this.notifyProgress(this.loadingState.total, this.loadingState.total);
    }

    updateLoadingState() {
        const realCurrentItem = Math.min(this.loadingState.current++, this.loadingState.total);
        if (realCurrentItem / this.loadingState.total >= this.loadingState.step) {
            const currentProgress = Math.ceil(this.loadingState.total * this.loadingState.step);
            this.notifyProgress(currentProgress, this.loadingState.total);
            this.loadingState.step += 0.1;
        }
    }

    addOptionalCategories(modelID) {
        const optionalTypes = [];
        for (let key in this.optionalCategories) {
            if (this.optionalCategories.hasOwnProperty(key)) {
                const category = parseInt(key);
                if (this.optionalCategories[category])
                    optionalTypes.push(category);
            }
        }
        this.state.api.StreamAllMeshesWithTypes(this.currentWebIfcID, optionalTypes, (mesh) => {
            this.streamMesh(modelID, mesh);
        });
    }

    streamMesh(modelID, mesh) {
        const placedGeometries = mesh.geometries;
        const size = placedGeometries.size();
        for (let i = 0; i < size; i++) {
            const placedGeometry = placedGeometries.get(i);
            let itemMesh = this.getPlacedGeometry(modelID, mesh.expressID, placedGeometry);
            let geom = itemMesh.geometry.applyMatrix4(itemMesh.matrix);
            this.storeGeometryByMaterial(placedGeometry.color, geom);
        }
    }

    getPlacedGeometry(modelID, expressID, placedGeometry) {
        const geometry = this.getBufferGeometry(modelID, expressID, placedGeometry);
        const mesh = new Mesh(geometry);
        mesh.matrix = this.getMeshMatrix(placedGeometry.flatTransformation);
        mesh.matrixAutoUpdate = false;
        return mesh;
    }

    getBufferGeometry(modelID, expressID, placedGeometry) {
        const geometry = this.state.api.GetGeometry(modelID, placedGeometry.geometryExpressID);
        const verts = this.state.api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = this.state.api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
        const buffer = this.ifcGeometryToBuffer(expressID, verts, indices);
        geometry.delete();
        return buffer;
    }

    storeGeometryByMaterial(color, geometry) {
        let colID = `${color.x}${color.y}${color.z}${color.w}`;
        if (this.geometriesByMaterials[colID]) {
            this.geometriesByMaterials[colID].geometries.push(geometry);
            return;
        }
        const col = new Color(color.x, color.y, color.z);
        const material = new MeshLambertMaterial({
            color: col,
            side: DoubleSide
        });
        material.transparent = color.w !== 1;
        if (material.transparent)
            material.opacity = color.w;
        this.geometriesByMaterials[colID] = {
            material,
            geometries: [geometry]
        };
    }

    getMeshMatrix(matrix) {
        const mat = new Matrix4();
        mat.fromArray(matrix);
        return mat;
    }

    ifcGeometryToBuffer(expressID, vertexData, indexData) {
        const geometry = new BufferGeometry();
        const posFloats = new Float32Array(vertexData.length / 2);
        const normFloats = new Float32Array(vertexData.length / 2);
        const idAttribute = new Uint32Array(vertexData.length / 6);
        for (let i = 0; i < vertexData.length; i += 6) {
            posFloats[i / 2] = vertexData[i];
            posFloats[i / 2 + 1] = vertexData[i + 1];
            posFloats[i / 2 + 2] = vertexData[i + 2];
            normFloats[i / 2] = vertexData[i + 3];
            normFloats[i / 2 + 1] = vertexData[i + 4];
            normFloats[i / 2 + 2] = vertexData[i + 5];
            idAttribute[i / 6] = expressID;
        }
        geometry.setAttribute('position', new BufferAttribute(posFloats, 3));
        geometry.setAttribute('normal', new BufferAttribute(normFloats, 3));
        geometry.setAttribute('expressID', new BufferAttribute(idAttribute, 1));
        geometry.setIndex(new BufferAttribute(indexData, 1));
        return geometry;
    }

    cleanUpGeometryMemory(geometries) {
        geometries.forEach(geometry => geometry.dispose());
        Object.keys(this.geometriesByMaterials).forEach((materialID) => {
            const geometriesByMaterial = this.geometriesByMaterials[materialID];
            geometriesByMaterial.geometries.forEach(geometry => geometry.dispose());
            geometriesByMaterial.geometries = [];
            geometriesByMaterial.material = null;
        });
        this.geometriesByMaterials = {};
    }

}

class ItemsMap {

    constructor(state) {
        this.state = state;
        this.map = {};
    }

    generateGeometryIndexMap(modelID) {
        if (this.map[modelID])
            return;
        const geometry = this.getGeometry(modelID);
        const items = this.newItemsMap(modelID, geometry);
        for (const group of geometry.groups) {
            this.fillItemsWithGroupInfo(group, geometry, items);
        }
    }

    getSubsetID(modelID, material, customID = 'DEFAULT') {
        const baseID = modelID;
        const materialID = material ? material.uuid : 'DEFAULT';
        return `${baseID} - ${materialID} - ${customID}`;
    }

    dispose() {
        Object.values(this.map).forEach(model => {
            model.indexCache = null;
            model.map = null;
        });
        this.map = null;
    }

    getGeometry(modelID) {
        const geometry = this.state.models[modelID].mesh.geometry;
        if (!geometry)
            throw new Error('Model without geometry.');
        if (!geometry.index)
            throw new Error('Geometry must be indexed');
        return geometry;
    }

    newItemsMap(modelID, geometry) {
        const startIndices = geometry.index.array;
        this.map[modelID] = {
            indexCache: startIndices.slice(0, geometry.index.array.length),
            map: new Map()
        };
        return this.map[modelID];
    }

    fillItemsWithGroupInfo(group, geometry, items) {
        let prevExpressID = -1;
        const materialIndex = group.materialIndex;
        const materialStart = group.start;
        const materialEnd = materialStart + group.count - 1;
        let objectStart = -1;
        let objectEnd = -1;
        for (let i = materialStart; i <= materialEnd; i++) {
            const index = geometry.index.array[i];
            const expressID = geometry.attributes.expressID.array[index];
            if (prevExpressID === -1) {
                prevExpressID = expressID;
                objectStart = i;
            }
            const isEndOfMaterial = i === materialEnd;
            if (isEndOfMaterial) {
                const store = this.getMaterialStore(items.map, expressID, materialIndex);
                store.push(objectStart, materialEnd);
                break;
            }
            if (prevExpressID === expressID)
                continue;
            const store = this.getMaterialStore(items.map, prevExpressID, materialIndex);
            objectEnd = i - 1;
            store.push(objectStart, objectEnd);
            prevExpressID = expressID;
            objectStart = i;
        }
    }

    getMaterialStore(map, id, matIndex) {
        if (map.get(id) === undefined) {
            map.set(id, {});
        }
        const storedIfcItem = map.get(id);
        if (storedIfcItem === undefined)
            throw new Error('Geometry map generation error');
        if (storedIfcItem[matIndex] === undefined) {
            storedIfcItem[matIndex] = [];
        }
        return storedIfcItem[matIndex];
    }

}

class SubsetUtils {

    static getAllIndicesOfGroup(modelID, ids, materialIndex, items, flatten = true) {
        const indicesByGroup = [];
        for (const expressID of ids) {
            const entry = items.map.get(expressID);
            if (!entry)
                continue;
            const value = entry[materialIndex];
            if (!value)
                continue;
            SubsetUtils.getIndexChunk(value, indicesByGroup, materialIndex, items, flatten);
        }
        return indicesByGroup;
    }

    static getIndexChunk(value, indicesByGroup, materialIndex, items, flatten) {
        const pairs = value.length / 2;
        for (let pair = 0; pair < pairs; pair++) {
            const pairIndex = pair * 2;
            const start = value[pairIndex];
            const end = value[pairIndex + 1];
            for (let j = start; j <= end; j++) {
                if (flatten)
                    indicesByGroup.push(items.indexCache[j]);
                else {
                    if (!indicesByGroup[materialIndex])
                        indicesByGroup[materialIndex] = [];
                    indicesByGroup[materialIndex].push(items.indexCache[j]);
                }
            }
        }
    }

}

class SubsetCreator {

    constructor(state, items, subsets, BVH) {
        this.state = state;
        this.items = items;
        this.subsets = subsets;
        this.BVH = BVH;
        this.tempIndex = [];
    }

    createSubset(config, subsetID) {
        if (!this.items.map[config.modelID])
            this.items.generateGeometryIndexMap(config.modelID);
        if (!this.subsets[subsetID])
            this.initializeSubset(config, subsetID);
        this.filterIndices(config, subsetID);
        this.constructSubsetByMaterial(config, subsetID);
        config.ids.forEach(id => this.subsets[subsetID].ids.add(id));
        this.subsets[subsetID].mesh.geometry.setIndex(this.tempIndex);
        this.tempIndex.length = 0;
        const subset = this.subsets[subsetID].mesh;
        if (config.applyBVH)
            this.BVH.applyThreeMeshBVH(subset.geometry);
        if (config.scene)
            config.scene.add(subset);
        return this.subsets[subsetID].mesh;
    }

    dispose() {
        this.tempIndex = [];
    }

    initializeSubset(config, subsetID) {
        const model = this.state.models[config.modelID].mesh;
        const subsetGeom = new BufferGeometry();
        this.initializeSubsetAttributes(subsetGeom, model);
        if (!config.material)
            this.initializeSubsetGroups(subsetGeom, model);
        const mesh = new Mesh(subsetGeom, config.material || model.material);
        mesh.modelID = config.modelID;
        const bvh = Boolean(config.applyBVH);
        this.subsets[subsetID] = {
            ids: new Set(),
            mesh,
            bvh
        };
        model.add(mesh);
    }

    initializeSubsetAttributes(subsetGeom, model) {
        subsetGeom.setAttribute('position', model.geometry.attributes.position);
        subsetGeom.setAttribute('normal', model.geometry.attributes.normal);
        subsetGeom.setAttribute('expressID', model.geometry.attributes.expressID);
        subsetGeom.setIndex([]);
    }

    initializeSubsetGroups(subsetGeom, model) {
        subsetGeom.groups = JSON.parse(JSON.stringify(model.geometry.groups));
        this.resetGroups(subsetGeom);
    }

    filterIndices(config, subsetID) {
        const geometry = this.subsets[subsetID].mesh.geometry;
        if (config.removePrevious) {
            geometry.setIndex([]);
            this.resetGroups(geometry);
            return;
        }
        const previousIndices = geometry.index.array;
        const previousIDs = this.subsets[subsetID].ids;
        config.ids = config.ids.filter(id => !previousIDs.has(id));
        this.tempIndex = Array.from(previousIndices);
    }

    constructSubsetByMaterial(config, subsetID) {
        const model = this.state.models[config.modelID].mesh;
        const newIndices = {
            count: 0
        };
        for (let i = 0; i < model.geometry.groups.length; i++) {
            this.insertNewIndices(config, subsetID, i, newIndices);
        }
    }

    insertNewIndices(config, subsetID, materialIndex, newIndices) {
        const items = this.items.map[config.modelID];
        const indicesOfOneMaterial = SubsetUtils.getAllIndicesOfGroup(config.modelID, config.ids, materialIndex, items);
        if (!config.material) {
            this.insertIndicesAtGroup(subsetID, indicesOfOneMaterial, materialIndex, newIndices);
        } else {
            indicesOfOneMaterial.forEach(index => this.tempIndex.push(index));
        }
    }

    insertIndicesAtGroup(subsetID, indicesByGroup, index, newIndices) {
        const currentGroup = this.getCurrentGroup(subsetID, index);
        currentGroup.start += newIndices.count;
        let newIndicesPosition = currentGroup.start + currentGroup.count;
        newIndices.count += indicesByGroup.length;
        if (indicesByGroup.length > 0) {
            let position = newIndicesPosition;
            const start = this.tempIndex.slice(0, position);
            const end = this.tempIndex.slice(position);
            this.tempIndex = Array.prototype.concat.apply([], [start, indicesByGroup, end]);
            currentGroup.count += indicesByGroup.length;
        }
    }

    getCurrentGroup(subsetID, groupIndex) {
        const geometry = this.subsets[subsetID].mesh.geometry;
        return geometry.groups[groupIndex];
    }

    resetGroups(geometry) {
        geometry.groups.forEach((group) => {
            group.start = 0;
            group.count = 0;
        });
    }

}

class SubsetManager {

    constructor(state, BVH) {
        this.subsets = {};
        this.state = state;
        this.items = new ItemsMap(state);
        this.BVH = BVH;
        this.subsetCreator = new SubsetCreator(state, this.items, this.subsets, this.BVH);
    }

    getAllSubsets() {
        return this.subsets;
    }

    getSubset(modelID, material, customId) {
        const subsetID = this.getSubsetID(modelID, material, customId);
        return this.subsets[subsetID].mesh;
    }

    removeSubset(modelID, material, customID) {
        const subsetID = this.getSubsetID(modelID, material, customID);
        const subset = this.subsets[subsetID];
        if (!subset)
            return;
        if (subset.mesh.parent)
            subset.mesh.removeFromParent();
        subset.mesh.geometry.attributes = {};
        subset.mesh.geometry.index = null;
        subset.mesh.geometry.dispose();
        subset.mesh.geometry = null;
        delete this.subsets[subsetID];
    }

    createSubset(config) {
        const subsetID = this.getSubsetID(config.modelID, config.material, config.customID);
        return this.subsetCreator.createSubset(config, subsetID);
    }

    removeFromSubset(modelID, ids, customID, material) {
        const subsetID = this.getSubsetID(modelID, material, customID);
        if (!this.subsets[subsetID])
            return;
        const previousIDs = this.subsets[subsetID].ids;
        ids.forEach((id) => {
            if (previousIDs.has(id))
                previousIDs.delete(id);
        });
        return this.createSubset({
            modelID,
            removePrevious: true,
            material,
            customID,
            applyBVH: this.subsets[subsetID].bvh,
            ids: Array.from(previousIDs),
            scene: this.subsets[subsetID].mesh.parent
        });
    }

    clearSubset(modelID, customID, material) {
        const subsetID = this.getSubsetID(modelID, material, customID);
        if (!this.subsets[subsetID])
            return;
        this.subsets[subsetID].ids.clear();
        const subset = this.getSubset(modelID, material, customID);
        subset.geometry.setIndex([]);
    }

    dispose() {
        this.items.dispose();
        this.subsetCreator.dispose();
        Object.values(this.subsets).forEach(subset => {
            subset.ids = null;
            subset.mesh.removeFromParent();
            const mats = subset.mesh.material;
            if (Array.isArray(mats))
                mats.forEach(mat => mat.dispose());
            else
                mats.dispose();
            subset.mesh.geometry.index = null;
            subset.mesh.geometry.dispose();
            const geom = subset.mesh.geometry;
            if (geom.disposeBoundsTree)
                geom.disposeBoundsTree();
            subset.mesh = null;
        });
        this.subsets = null;
    }

    getSubsetID(modelID, material, customID = 'DEFAULT') {
        const baseID = modelID;
        const materialID = material ? material.uuid : 'DEFAULT';
        return `${baseID} - ${materialID} - ${customID}`;
    }

}

const IdAttrName = 'expressID';
const PropsNames = {
    aggregates: {
        name: IFCRELAGGREGATES,
        relating: 'RelatingObject',
        related: 'RelatedObjects',
        key: 'children'
    },
    spatial: {
        name: IFCRELCONTAINEDINSPATIALSTRUCTURE,
        relating: 'RelatingStructure',
        related: 'RelatedElements',
        key: 'children'
    },
    psets: {
        name: IFCRELDEFINESBYPROPERTIES,
        relating: 'RelatingPropertyDefinition',
        related: 'RelatedObjects',
        key: 'hasPsets'
    },
    materials: {
        name: IFCRELASSOCIATESMATERIAL,
        relating: 'RelatingMaterial',
        related: 'RelatedObjects',
        key: 'hasMaterial'
    },
    type: {
        name: IFCRELDEFINESBYTYPE,
        relating: 'RelatingType',
        related: 'RelatedObjects',
        key: 'hasType'
    }
};

class BasePropertyManager {

    constructor(state) {
        this.state = state;
    }

    async getPropertySets(modelID, elementID, recursive = false) {
        return await this.getProperty(modelID, elementID, recursive, PropsNames.psets);
    }

    async getTypeProperties(modelID, elementID, recursive = false) {
        return await this.getProperty(modelID, elementID, recursive, PropsNames.type);
    }

    async getMaterialsProperties(modelID, elementID, recursive = false) {
        return await this.getProperty(modelID, elementID, recursive, PropsNames.materials);
    }

    async getSpatialNode(modelID, node, treeChunks, includeProperties) {
        await this.getChildren(modelID, node, treeChunks, PropsNames.aggregates, includeProperties);
        await this.getChildren(modelID, node, treeChunks, PropsNames.spatial, includeProperties);
    }

    async getChildren(modelID, node, treeChunks, propNames, includeProperties) {
        const children = treeChunks[node.expressID];
        if (children == undefined)
            return;
        const prop = propNames.key;
        const nodes = [];
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            let node = this.newNode(modelID, child);
            if (includeProperties) {
                const properties = await this.getItemProperties(modelID, node.expressID);
                node = {
                    ...properties, ...node
                };
            }
            await this.getSpatialNode(modelID, node, treeChunks, includeProperties);
            nodes.push(node);
        }
        node[prop] = nodes;
    }

    newNode(modelID, id) {
        const typeName = this.getNodeType(modelID, id);
        return {
            expressID: id,
            type: typeName,
            children: []
        };
    }

    async getSpatialTreeChunks(modelID) {
        const treeChunks = {};
        await this.getChunks(modelID, treeChunks, PropsNames.aggregates);
        await this.getChunks(modelID, treeChunks, PropsNames.spatial);
        return treeChunks;
    }

    saveChunk(chunks, propNames, rel) {
        const relating = rel[propNames.relating].value;
        const related = rel[propNames.related].map((r) => r.value);
        if (chunks[relating] == undefined) {
            chunks[relating] = related;
        } else {
            chunks[relating] = chunks[relating].concat(related);
        }
    }

    getRelated(rel, propNames, IDs) {
        const element = rel[propNames.relating];
        if (!element) {
            return console.warn(`The object with ID ${rel.expressID} has a broken reference.`);
        }
        if (!Array.isArray(element))
            IDs.push(element.value);
        else
            element.forEach((ele) => IDs.push(ele.value));
    }

    static isRelated(id, rel, propNames) {
        const relatedItems = rel[propNames.related];
        if (Array.isArray(relatedItems)) {
            const values = relatedItems.map((item) => item.value);
            return values.includes(id);
        }
        return relatedItems.value === id;
    }

    static newIfcProject(id) {
        return {
            expressID: id,
            type: 'IFCPROJECT',
            children: []
        };
    }

    async getProperty(modelID, elementID, recursive = false, propName) { }

    async getChunks(modelID, chunks, propNames) { }

    async getItemProperties(modelID, expressID, recursive = false) { }

    getNodeType(modelID, id) { }

}

let IfcElements = {
    103090709: 'IFCPROJECT',
    4097777520: 'IFCSITE',
    4031249490: 'IFCBUILDING',
    3124254112: 'IFCBUILDINGSTOREY',
    3856911033: 'IFCSPACE',
    1674181508: 'IFCANNOTATION',
    25142252: 'IFCCONTROLLER',
    32344328: 'IFCBOILER',
    76236018: 'IFCLAMP',
    90941305: 'IFCPUMP',
    177149247: 'IFCAIRTERMINALBOX',
    182646315: 'IFCFLOWINSTRUMENT',
    263784265: 'IFCFURNISHINGELEMENT',
    264262732: 'IFCELECTRICGENERATOR',
    277319702: 'IFCAUDIOVISUALAPPLIANCE',
    310824031: 'IFCPIPEFITTING',
    331165859: 'IFCSTAIR',
    342316401: 'IFCDUCTFITTING',
    377706215: 'IFCMECHANICALFASTENER',
    395920057: 'IFCDOOR',
    402227799: 'IFCELECTRICMOTOR',
    413509423: 'IFCSYSTEMFURNITUREELEMENT',
    484807127: 'IFCEVAPORATOR',
    486154966: 'IFCWINDOWSTANDARDCASE',
    629592764: 'IFCLIGHTFIXTURE',
    630975310: 'IFCUNITARYCONTROLELEMENT',
    635142910: 'IFCCABLECARRIERFITTING',
    639361253: 'IFCCOIL',
    647756555: 'IFCFASTENER',
    707683696: 'IFCFLOWSTORAGEDEVICE',
    738039164: 'IFCPROTECTIVEDEVICE',
    753842376: 'IFCBEAM',
    812556717: 'IFCTANK',
    819412036: 'IFCFILTER',
    843113511: 'IFCCOLUMN',
    862014818: 'IFCELECTRICDISTRIBUTIONBOARD',
    900683007: 'IFCFOOTING',
    905975707: 'IFCCOLUMNSTANDARDCASE',
    926996030: 'IFCVOIDINGFEATURE',
    979691226: 'IFCREINFORCINGBAR',
    987401354: 'IFCFLOWSEGMENT',
    1003880860: 'IFCELECTRICTIMECONTROL',
    1051757585: 'IFCCABLEFITTING',
    1052013943: 'IFCDISTRIBUTIONCHAMBERELEMENT',
    1062813311: 'IFCDISTRIBUTIONCONTROLELEMENT',
    1073191201: 'IFCMEMBER',
    1095909175: 'IFCBUILDINGELEMENTPROXY',
    1156407060: 'IFCPLATESTANDARDCASE',
    1162798199: 'IFCSWITCHINGDEVICE',
    1329646415: 'IFCSHADINGDEVICE',
    1335981549: 'IFCDISCRETEACCESSORY',
    1360408905: 'IFCDUCTSILENCER',
    1404847402: 'IFCSTACKTERMINAL',
    1426591983: 'IFCFIRESUPPRESSIONTERMINAL',
    1437502449: 'IFCMEDICALDEVICE',
    1509553395: 'IFCFURNITURE',
    1529196076: 'IFCSLAB',
    1620046519: 'IFCTRANSPORTELEMENT',
    1634111441: 'IFCAIRTERMINAL',
    1658829314: 'IFCENERGYCONVERSIONDEVICE',
    1677625105: 'IFCCIVILELEMENT',
    1687234759: 'IFCPILE',
    1904799276: 'IFCELECTRICAPPLIANCE',
    1911478936: 'IFCMEMBERSTANDARDCASE',
    1945004755: 'IFCDISTRIBUTIONELEMENT',
    1973544240: 'IFCCOVERING',
    1999602285: 'IFCSPACEHEATER',
    2016517767: 'IFCROOF',
    2056796094: 'IFCAIRTOAIRHEATRECOVERY',
    2058353004: 'IFCFLOWCONTROLLER',
    2068733104: 'IFCHUMIDIFIER',
    2176052936: 'IFCJUNCTIONBOX',
    2188021234: 'IFCFLOWMETER',
    2223149337: 'IFCFLOWTERMINAL',
    2262370178: 'IFCRAILING',
    2272882330: 'IFCCONDENSER',
    2295281155: 'IFCPROTECTIVEDEVICETRIPPINGUNIT',
    2320036040: 'IFCREINFORCINGMESH',
    2347447852: 'IFCTENDONANCHOR',
    2391383451: 'IFCVIBRATIONISOLATOR',
    2391406946: 'IFCWALL',
    2474470126: 'IFCMOTORCONNECTION',
    2769231204: 'IFCVIRTUALELEMENT',
    2814081492: 'IFCENGINE',
    2906023776: 'IFCBEAMSTANDARDCASE',
    2938176219: 'IFCBURNER',
    2979338954: 'IFCBUILDINGELEMENTPART',
    3024970846: 'IFCRAMP',
    3026737570: 'IFCTUBEBUNDLE',
    3027962421: 'IFCSLABSTANDARDCASE',
    3040386961: 'IFCDISTRIBUTIONFLOWELEMENT',
    3053780830: 'IFCSANITARYTERMINAL',
    3079942009: 'IFCOPENINGSTANDARDCASE',
    3087945054: 'IFCALARM',
    3101698114: 'IFCSURFACEFEATURE',
    3127900445: 'IFCSLABELEMENTEDCASE',
    3132237377: 'IFCFLOWMOVINGDEVICE',
    3171933400: 'IFCPLATE',
    3221913625: 'IFCCOMMUNICATIONSAPPLIANCE',
    3242481149: 'IFCDOORSTANDARDCASE',
    3283111854: 'IFCRAMPFLIGHT',
    3296154744: 'IFCCHIMNEY',
    3304561284: 'IFCWINDOW',
    3310460725: 'IFCELECTRICFLOWSTORAGEDEVICE',
    3319311131: 'IFCHEATEXCHANGER',
    3415622556: 'IFCFAN',
    3420628829: 'IFCSOLARDEVICE',
    3493046030: 'IFCGEOGRAPHICELEMENT',
    3495092785: 'IFCCURTAINWALL',
    3508470533: 'IFCFLOWTREATMENTDEVICE',
    3512223829: 'IFCWALLSTANDARDCASE',
    3518393246: 'IFCDUCTSEGMENT',
    3571504051: 'IFCCOMPRESSOR',
    3588315303: 'IFCOPENINGELEMENT',
    3612865200: 'IFCPIPESEGMENT',
    3640358203: 'IFCCOOLINGTOWER',
    3651124850: 'IFCPROJECTIONELEMENT',
    3694346114: 'IFCOUTLET',
    3747195512: 'IFCEVAPORATIVECOOLER',
    3758799889: 'IFCCABLECARRIERSEGMENT',
    3824725483: 'IFCTENDON',
    3825984169: 'IFCTRANSFORMER',
    3902619387: 'IFCCHILLER',
    4074379575: 'IFCDAMPER',
    4086658281: 'IFCSENSOR',
    4123344466: 'IFCELEMENTASSEMBLY',
    4136498852: 'IFCCOOLEDBEAM',
    4156078855: 'IFCWALLELEMENTEDCASE',
    4175244083: 'IFCINTERCEPTOR',
    4207607924: 'IFCVALVE',
    4217484030: 'IFCCABLESEGMENT',
    4237592921: 'IFCWASTETERMINAL',
    4252922144: 'IFCSTAIRFLIGHT',
    4278956645: 'IFCFLOWFITTING',
    4288193352: 'IFCACTUATOR',
    4292641817: 'IFCUNITARYEQUIPMENT',
    3009204131: 'IFCGRID'
};

class WebIfcPropertyManager extends BasePropertyManager {

    async getItemProperties(modelID, id, recursive = false) {
        return this.state.api.GetLine(modelID, id, recursive);
    }

    async getSpatialStructure(modelID, includeProperties) {
        const chunks = await this.getSpatialTreeChunks(modelID);
        const allLines = await this.state.api.GetLineIDsWithType(modelID, IFCPROJECT);
        const projectID = allLines.get(0);
        const project = WebIfcPropertyManager.newIfcProject(projectID);
        await this.getSpatialNode(modelID, project, chunks, includeProperties);
        return project;
    }

    async getAllItemsOfType(modelID, type, verbose) {
        let items = [];
        const lines = await this.state.api.GetLineIDsWithType(modelID, type);
        for (let i = 0; i < lines.size(); i++)
            items.push(lines.get(i));
        if (!verbose)
            return items;
        const result = [];
        for (let i = 0; i < items.length; i++) {
            result.push(await this.state.api.GetLine(modelID, items[i]));
        }
        return result;
    }

    async getProperty(modelID, elementID, recursive = false, propName) {
        const propSetIds = await this.getAllRelatedItemsOfType(modelID, elementID, propName);
        const result = [];
        for (let i = 0; i < propSetIds.length; i++) {
            result.push(await this.state.api.GetLine(modelID, propSetIds[i], recursive));
        }
        return result;
    }

    getNodeType(modelID, id) {
        const typeID = this.state.models[modelID].types[id];
        return IfcElements[typeID];
    }

    async getChunks(modelID, chunks, propNames) {
        const relation = await this.state.api.GetLineIDsWithType(modelID, propNames.name);
        for (let i = 0; i < relation.size(); i++) {
            const rel = await this.state.api.GetLine(modelID, relation.get(i), false);
            this.saveChunk(chunks, propNames, rel);
        }
    }

    async getAllRelatedItemsOfType(modelID, id, propNames) {
        const lines = await this.state.api.GetLineIDsWithType(modelID, propNames.name);
        const IDs = [];
        for (let i = 0; i < lines.size(); i++) {
            const rel = await this.state.api.GetLine(modelID, lines.get(i));
            const isRelated = BasePropertyManager.isRelated(id, rel, propNames);
            if (isRelated)
                this.getRelated(rel, propNames, IDs);
        }
        return IDs;
    }

}

let IfcTypesMap = {
    3821786052: "IFCACTIONREQUEST",
    2296667514: "IFCACTOR",
    3630933823: "IFCACTORROLE",
    4288193352: "IFCACTUATOR",
    2874132201: "IFCACTUATORTYPE",
    618182010: "IFCADDRESS",
    1635779807: "IFCADVANCEDBREP",
    2603310189: "IFCADVANCEDBREPWITHVOIDS",
    3406155212: "IFCADVANCEDFACE",
    1634111441: "IFCAIRTERMINAL",
    177149247: "IFCAIRTERMINALBOX",
    1411407467: "IFCAIRTERMINALBOXTYPE",
    3352864051: "IFCAIRTERMINALTYPE",
    2056796094: "IFCAIRTOAIRHEATRECOVERY",
    1871374353: "IFCAIRTOAIRHEATRECOVERYTYPE",
    3087945054: "IFCALARM",
    3001207471: "IFCALARMTYPE",
    325726236: "IFCALIGNMENT",
    749761778: "IFCALIGNMENT2DHORIZONTAL",
    3199563722: "IFCALIGNMENT2DHORIZONTALSEGMENT",
    2483840362: "IFCALIGNMENT2DSEGMENT",
    3379348081: "IFCALIGNMENT2DVERSEGCIRCULARARC",
    3239324667: "IFCALIGNMENT2DVERSEGLINE",
    4263986512: "IFCALIGNMENT2DVERSEGPARABOLICARC",
    53199957: "IFCALIGNMENT2DVERTICAL",
    2029264950: "IFCALIGNMENT2DVERTICALSEGMENT",
    3512275521: "IFCALIGNMENTCURVE",
    1674181508: "IFCANNOTATION",
    669184980: "IFCANNOTATIONFILLAREA",
    639542469: "IFCAPPLICATION",
    411424972: "IFCAPPLIEDVALUE",
    130549933: "IFCAPPROVAL",
    3869604511: "IFCAPPROVALRELATIONSHIP",
    3798115385: "IFCARBITRARYCLOSEDPROFILEDEF",
    1310608509: "IFCARBITRARYOPENPROFILEDEF",
    2705031697: "IFCARBITRARYPROFILEDEFWITHVOIDS",
    3460190687: "IFCASSET",
    3207858831: "IFCASYMMETRICISHAPEPROFILEDEF",
    277319702: "IFCAUDIOVISUALAPPLIANCE",
    1532957894: "IFCAUDIOVISUALAPPLIANCETYPE",
    4261334040: "IFCAXIS1PLACEMENT",
    3125803723: "IFCAXIS2PLACEMENT2D",
    2740243338: "IFCAXIS2PLACEMENT3D",
    1967976161: "IFCBSPLINECURVE",
    2461110595: "IFCBSPLINECURVEWITHKNOTS",
    2887950389: "IFCBSPLINESURFACE",
    167062518: "IFCBSPLINESURFACEWITHKNOTS",
    753842376: "IFCBEAM",
    2906023776: "IFCBEAMSTANDARDCASE",
    819618141: "IFCBEAMTYPE",
    4196446775: "IFCBEARING",
    3649138523: "IFCBEARINGTYPE",
    616511568: "IFCBLOBTEXTURE",
    1334484129: "IFCBLOCK",
    32344328: "IFCBOILER",
    231477066: "IFCBOILERTYPE",
    3649129432: "IFCBOOLEANCLIPPINGRESULT",
    2736907675: "IFCBOOLEANRESULT",
    4037036970: "IFCBOUNDARYCONDITION",
    1136057603: "IFCBOUNDARYCURVE",
    1560379544: "IFCBOUNDARYEDGECONDITION",
    3367102660: "IFCBOUNDARYFACECONDITION",
    1387855156: "IFCBOUNDARYNODECONDITION",
    2069777674: "IFCBOUNDARYNODECONDITIONWARPING",
    1260505505: "IFCBOUNDEDCURVE",
    4182860854: "IFCBOUNDEDSURFACE",
    2581212453: "IFCBOUNDINGBOX",
    2713105998: "IFCBOXEDHALFSPACE",
    644574406: "IFCBRIDGE",
    963979645: "IFCBRIDGEPART",
    4031249490: "IFCBUILDING",
    3299480353: "IFCBUILDINGELEMENT",
    2979338954: "IFCBUILDINGELEMENTPART",
    39481116: "IFCBUILDINGELEMENTPARTTYPE",
    1095909175: "IFCBUILDINGELEMENTPROXY",
    1909888760: "IFCBUILDINGELEMENTPROXYTYPE",
    1950629157: "IFCBUILDINGELEMENTTYPE",
    3124254112: "IFCBUILDINGSTOREY",
    1177604601: "IFCBUILDINGSYSTEM",
    2938176219: "IFCBURNER",
    2188180465: "IFCBURNERTYPE",
    2898889636: "IFCCSHAPEPROFILEDEF",
    635142910: "IFCCABLECARRIERFITTING",
    395041908: "IFCCABLECARRIERFITTINGTYPE",
    3758799889: "IFCCABLECARRIERSEGMENT",
    3293546465: "IFCCABLECARRIERSEGMENTTYPE",
    1051757585: "IFCCABLEFITTING",
    2674252688: "IFCCABLEFITTINGTYPE",
    4217484030: "IFCCABLESEGMENT",
    1285652485: "IFCCABLESEGMENTTYPE",
    3999819293: "IFCCAISSONFOUNDATION",
    3203706013: "IFCCAISSONFOUNDATIONTYPE",
    1123145078: "IFCCARTESIANPOINT",
    574549367: "IFCCARTESIANPOINTLIST",
    1675464909: "IFCCARTESIANPOINTLIST2D",
    2059837836: "IFCCARTESIANPOINTLIST3D",
    59481748: "IFCCARTESIANTRANSFORMATIONOPERATOR",
    3749851601: "IFCCARTESIANTRANSFORMATIONOPERATOR2D",
    3486308946: "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM",
    3331915920: "IFCCARTESIANTRANSFORMATIONOPERATOR3D",
    1416205885: "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM",
    3150382593: "IFCCENTERLINEPROFILEDEF",
    3902619387: "IFCCHILLER",
    2951183804: "IFCCHILLERTYPE",
    3296154744: "IFCCHIMNEY",
    2197970202: "IFCCHIMNEYTYPE",
    2611217952: "IFCCIRCLE",
    2937912522: "IFCCIRCLEHOLLOWPROFILEDEF",
    1383045692: "IFCCIRCLEPROFILEDEF",
    1062206242: "IFCCIRCULARARCSEGMENT2D",
    1677625105: "IFCCIVILELEMENT",
    3893394355: "IFCCIVILELEMENTTYPE",
    747523909: "IFCCLASSIFICATION",
    647927063: "IFCCLASSIFICATIONREFERENCE",
    2205249479: "IFCCLOSEDSHELL",
    639361253: "IFCCOIL",
    2301859152: "IFCCOILTYPE",
    776857604: "IFCCOLOURRGB",
    3285139300: "IFCCOLOURRGBLIST",
    3264961684: "IFCCOLOURSPECIFICATION",
    843113511: "IFCCOLUMN",
    905975707: "IFCCOLUMNSTANDARDCASE",
    300633059: "IFCCOLUMNTYPE",
    3221913625: "IFCCOMMUNICATIONSAPPLIANCE",
    400855858: "IFCCOMMUNICATIONSAPPLIANCETYPE",
    2542286263: "IFCCOMPLEXPROPERTY",
    3875453745: "IFCCOMPLEXPROPERTYTEMPLATE",
    3732776249: "IFCCOMPOSITECURVE",
    15328376: "IFCCOMPOSITECURVEONSURFACE",
    2485617015: "IFCCOMPOSITECURVESEGMENT",
    1485152156: "IFCCOMPOSITEPROFILEDEF",
    3571504051: "IFCCOMPRESSOR",
    3850581409: "IFCCOMPRESSORTYPE",
    2272882330: "IFCCONDENSER",
    2816379211: "IFCCONDENSERTYPE",
    2510884976: "IFCCONIC",
    370225590: "IFCCONNECTEDFACESET",
    1981873012: "IFCCONNECTIONCURVEGEOMETRY",
    2859738748: "IFCCONNECTIONGEOMETRY",
    45288368: "IFCCONNECTIONPOINTECCENTRICITY",
    2614616156: "IFCCONNECTIONPOINTGEOMETRY",
    2732653382: "IFCCONNECTIONSURFACEGEOMETRY",
    775493141: "IFCCONNECTIONVOLUMEGEOMETRY",
    1959218052: "IFCCONSTRAINT",
    3898045240: "IFCCONSTRUCTIONEQUIPMENTRESOURCE",
    2185764099: "IFCCONSTRUCTIONEQUIPMENTRESOURCETYPE",
    1060000209: "IFCCONSTRUCTIONMATERIALRESOURCE",
    4105962743: "IFCCONSTRUCTIONMATERIALRESOURCETYPE",
    488727124: "IFCCONSTRUCTIONPRODUCTRESOURCE",
    1525564444: "IFCCONSTRUCTIONPRODUCTRESOURCETYPE",
    2559216714: "IFCCONSTRUCTIONRESOURCE",
    2574617495: "IFCCONSTRUCTIONRESOURCETYPE",
    3419103109: "IFCCONTEXT",
    3050246964: "IFCCONTEXTDEPENDENTUNIT",
    3293443760: "IFCCONTROL",
    25142252: "IFCCONTROLLER",
    578613899: "IFCCONTROLLERTYPE",
    2889183280: "IFCCONVERSIONBASEDUNIT",
    2713554722: "IFCCONVERSIONBASEDUNITWITHOFFSET",
    4136498852: "IFCCOOLEDBEAM",
    335055490: "IFCCOOLEDBEAMTYPE",
    3640358203: "IFCCOOLINGTOWER",
    2954562838: "IFCCOOLINGTOWERTYPE",
    1785450214: "IFCCOORDINATEOPERATION",
    1466758467: "IFCCOORDINATEREFERENCESYSTEM",
    3895139033: "IFCCOSTITEM",
    1419761937: "IFCCOSTSCHEDULE",
    602808272: "IFCCOSTVALUE",
    1973544240: "IFCCOVERING",
    1916426348: "IFCCOVERINGTYPE",
    3295246426: "IFCCREWRESOURCE",
    1815067380: "IFCCREWRESOURCETYPE",
    2506170314: "IFCCSGPRIMITIVE3D",
    2147822146: "IFCCSGSOLID",
    539742890: "IFCCURRENCYRELATIONSHIP",
    3495092785: "IFCCURTAINWALL",
    1457835157: "IFCCURTAINWALLTYPE",
    2601014836: "IFCCURVE",
    2827736869: "IFCCURVEBOUNDEDPLANE",
    2629017746: "IFCCURVEBOUNDEDSURFACE",
    1186437898: "IFCCURVESEGMENT2D",
    3800577675: "IFCCURVESTYLE",
    1105321065: "IFCCURVESTYLEFONT",
    2367409068: "IFCCURVESTYLEFONTANDSCALING",
    3510044353: "IFCCURVESTYLEFONTPATTERN",
    1213902940: "IFCCYLINDRICALSURFACE",
    4074379575: "IFCDAMPER",
    3961806047: "IFCDAMPERTYPE",
    3426335179: "IFCDEEPFOUNDATION",
    1306400036: "IFCDEEPFOUNDATIONTYPE",
    3632507154: "IFCDERIVEDPROFILEDEF",
    1765591967: "IFCDERIVEDUNIT",
    1045800335: "IFCDERIVEDUNITELEMENT",
    2949456006: "IFCDIMENSIONALEXPONENTS",
    32440307: "IFCDIRECTION",
    1335981549: "IFCDISCRETEACCESSORY",
    2635815018: "IFCDISCRETEACCESSORYTYPE",
    1945343521: "IFCDISTANCEEXPRESSION",
    1052013943: "IFCDISTRIBUTIONCHAMBERELEMENT",
    1599208980: "IFCDISTRIBUTIONCHAMBERELEMENTTYPE",
    562808652: "IFCDISTRIBUTIONCIRCUIT",
    1062813311: "IFCDISTRIBUTIONCONTROLELEMENT",
    2063403501: "IFCDISTRIBUTIONCONTROLELEMENTTYPE",
    1945004755: "IFCDISTRIBUTIONELEMENT",
    3256556792: "IFCDISTRIBUTIONELEMENTTYPE",
    3040386961: "IFCDISTRIBUTIONFLOWELEMENT",
    3849074793: "IFCDISTRIBUTIONFLOWELEMENTTYPE",
    3041715199: "IFCDISTRIBUTIONPORT",
    3205830791: "IFCDISTRIBUTIONSYSTEM",
    1154170062: "IFCDOCUMENTINFORMATION",
    770865208: "IFCDOCUMENTINFORMATIONRELATIONSHIP",
    3732053477: "IFCDOCUMENTREFERENCE",
    395920057: "IFCDOOR",
    2963535650: "IFCDOORLININGPROPERTIES",
    1714330368: "IFCDOORPANELPROPERTIES",
    3242481149: "IFCDOORSTANDARDCASE",
    526551008: "IFCDOORSTYLE",
    2323601079: "IFCDOORTYPE",
    445594917: "IFCDRAUGHTINGPREDEFINEDCOLOUR",
    4006246654: "IFCDRAUGHTINGPREDEFINEDCURVEFONT",
    342316401: "IFCDUCTFITTING",
    869906466: "IFCDUCTFITTINGTYPE",
    3518393246: "IFCDUCTSEGMENT",
    3760055223: "IFCDUCTSEGMENTTYPE",
    1360408905: "IFCDUCTSILENCER",
    2030761528: "IFCDUCTSILENCERTYPE",
    3900360178: "IFCEDGE",
    476780140: "IFCEDGECURVE",
    1472233963: "IFCEDGELOOP",
    1904799276: "IFCELECTRICAPPLIANCE",
    663422040: "IFCELECTRICAPPLIANCETYPE",
    862014818: "IFCELECTRICDISTRIBUTIONBOARD",
    2417008758: "IFCELECTRICDISTRIBUTIONBOARDTYPE",
    3310460725: "IFCELECTRICFLOWSTORAGEDEVICE",
    3277789161: "IFCELECTRICFLOWSTORAGEDEVICETYPE",
    264262732: "IFCELECTRICGENERATOR",
    1534661035: "IFCELECTRICGENERATORTYPE",
    402227799: "IFCELECTRICMOTOR",
    1217240411: "IFCELECTRICMOTORTYPE",
    1003880860: "IFCELECTRICTIMECONTROL",
    712377611: "IFCELECTRICTIMECONTROLTYPE",
    1758889154: "IFCELEMENT",
    4123344466: "IFCELEMENTASSEMBLY",
    2397081782: "IFCELEMENTASSEMBLYTYPE",
    1623761950: "IFCELEMENTCOMPONENT",
    2590856083: "IFCELEMENTCOMPONENTTYPE",
    1883228015: "IFCELEMENTQUANTITY",
    339256511: "IFCELEMENTTYPE",
    2777663545: "IFCELEMENTARYSURFACE",
    1704287377: "IFCELLIPSE",
    2835456948: "IFCELLIPSEPROFILEDEF",
    1658829314: "IFCENERGYCONVERSIONDEVICE",
    2107101300: "IFCENERGYCONVERSIONDEVICETYPE",
    2814081492: "IFCENGINE",
    132023988: "IFCENGINETYPE",
    3747195512: "IFCEVAPORATIVECOOLER",
    3174744832: "IFCEVAPORATIVECOOLERTYPE",
    484807127: "IFCEVAPORATOR",
    3390157468: "IFCEVAPORATORTYPE",
    4148101412: "IFCEVENT",
    211053100: "IFCEVENTTIME",
    4024345920: "IFCEVENTTYPE",
    297599258: "IFCEXTENDEDPROPERTIES",
    4294318154: "IFCEXTERNALINFORMATION",
    3200245327: "IFCEXTERNALREFERENCE",
    1437805879: "IFCEXTERNALREFERENCERELATIONSHIP",
    1209101575: "IFCEXTERNALSPATIALELEMENT",
    2853485674: "IFCEXTERNALSPATIALSTRUCTUREELEMENT",
    2242383968: "IFCEXTERNALLYDEFINEDHATCHSTYLE",
    1040185647: "IFCEXTERNALLYDEFINEDSURFACESTYLE",
    3548104201: "IFCEXTERNALLYDEFINEDTEXTFONT",
    477187591: "IFCEXTRUDEDAREASOLID",
    2804161546: "IFCEXTRUDEDAREASOLIDTAPERED",
    2556980723: "IFCFACE",
    2047409740: "IFCFACEBASEDSURFACEMODEL",
    1809719519: "IFCFACEBOUND",
    803316827: "IFCFACEOUTERBOUND",
    3008276851: "IFCFACESURFACE",
    807026263: "IFCFACETEDBREP",
    3737207727: "IFCFACETEDBREPWITHVOIDS",
    24185140: "IFCFACILITY",
    1310830890: "IFCFACILITYPART",
    4219587988: "IFCFAILURECONNECTIONCONDITION",
    3415622556: "IFCFAN",
    346874300: "IFCFANTYPE",
    647756555: "IFCFASTENER",
    2489546625: "IFCFASTENERTYPE",
    2827207264: "IFCFEATUREELEMENT",
    2143335405: "IFCFEATUREELEMENTADDITION",
    1287392070: "IFCFEATUREELEMENTSUBTRACTION",
    738692330: "IFCFILLAREASTYLE",
    374418227: "IFCFILLAREASTYLEHATCHING",
    315944413: "IFCFILLAREASTYLETILES",
    819412036: "IFCFILTER",
    1810631287: "IFCFILTERTYPE",
    1426591983: "IFCFIRESUPPRESSIONTERMINAL",
    4222183408: "IFCFIRESUPPRESSIONTERMINALTYPE",
    2652556860: "IFCFIXEDREFERENCESWEPTAREASOLID",
    2058353004: "IFCFLOWCONTROLLER",
    3907093117: "IFCFLOWCONTROLLERTYPE",
    4278956645: "IFCFLOWFITTING",
    3198132628: "IFCFLOWFITTINGTYPE",
    182646315: "IFCFLOWINSTRUMENT",
    4037862832: "IFCFLOWINSTRUMENTTYPE",
    2188021234: "IFCFLOWMETER",
    3815607619: "IFCFLOWMETERTYPE",
    3132237377: "IFCFLOWMOVINGDEVICE",
    1482959167: "IFCFLOWMOVINGDEVICETYPE",
    987401354: "IFCFLOWSEGMENT",
    1834744321: "IFCFLOWSEGMENTTYPE",
    707683696: "IFCFLOWSTORAGEDEVICE",
    1339347760: "IFCFLOWSTORAGEDEVICETYPE",
    2223149337: "IFCFLOWTERMINAL",
    2297155007: "IFCFLOWTERMINALTYPE",
    3508470533: "IFCFLOWTREATMENTDEVICE",
    3009222698: "IFCFLOWTREATMENTDEVICETYPE",
    900683007: "IFCFOOTING",
    1893162501: "IFCFOOTINGTYPE",
    263784265: "IFCFURNISHINGELEMENT",
    4238390223: "IFCFURNISHINGELEMENTTYPE",
    1509553395: "IFCFURNITURE",
    1268542332: "IFCFURNITURETYPE",
    3493046030: "IFCGEOGRAPHICELEMENT",
    4095422895: "IFCGEOGRAPHICELEMENTTYPE",
    987898635: "IFCGEOMETRICCURVESET",
    3448662350: "IFCGEOMETRICREPRESENTATIONCONTEXT",
    2453401579: "IFCGEOMETRICREPRESENTATIONITEM",
    4142052618: "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
    3590301190: "IFCGEOMETRICSET",
    3009204131: "IFCGRID",
    852622518: "IFCGRIDAXIS",
    178086475: "IFCGRIDPLACEMENT",
    2706460486: "IFCGROUP",
    812098782: "IFCHALFSPACESOLID",
    3319311131: "IFCHEATEXCHANGER",
    1251058090: "IFCHEATEXCHANGERTYPE",
    2068733104: "IFCHUMIDIFIER",
    1806887404: "IFCHUMIDIFIERTYPE",
    1484403080: "IFCISHAPEPROFILEDEF",
    3905492369: "IFCIMAGETEXTURE",
    3570813810: "IFCINDEXEDCOLOURMAP",
    2571569899: "IFCINDEXEDPOLYCURVE",
    178912537: "IFCINDEXEDPOLYGONALFACE",
    2294589976: "IFCINDEXEDPOLYGONALFACEWITHVOIDS",
    1437953363: "IFCINDEXEDTEXTUREMAP",
    2133299955: "IFCINDEXEDTRIANGLETEXTUREMAP",
    4175244083: "IFCINTERCEPTOR",
    3946677679: "IFCINTERCEPTORTYPE",
    3113134337: "IFCINTERSECTIONCURVE",
    2391368822: "IFCINVENTORY",
    3741457305: "IFCIRREGULARTIMESERIES",
    3020489413: "IFCIRREGULARTIMESERIESVALUE",
    2176052936: "IFCJUNCTIONBOX",
    4288270099: "IFCJUNCTIONBOXTYPE",
    572779678: "IFCLSHAPEPROFILEDEF",
    3827777499: "IFCLABORRESOURCE",
    428585644: "IFCLABORRESOURCETYPE",
    1585845231: "IFCLAGTIME",
    76236018: "IFCLAMP",
    1051575348: "IFCLAMPTYPE",
    2655187982: "IFCLIBRARYINFORMATION",
    3452421091: "IFCLIBRARYREFERENCE",
    4162380809: "IFCLIGHTDISTRIBUTIONDATA",
    629592764: "IFCLIGHTFIXTURE",
    1161773419: "IFCLIGHTFIXTURETYPE",
    1566485204: "IFCLIGHTINTENSITYDISTRIBUTION",
    1402838566: "IFCLIGHTSOURCE",
    125510826: "IFCLIGHTSOURCEAMBIENT",
    2604431987: "IFCLIGHTSOURCEDIRECTIONAL",
    4266656042: "IFCLIGHTSOURCEGONIOMETRIC",
    1520743889: "IFCLIGHTSOURCEPOSITIONAL",
    3422422726: "IFCLIGHTSOURCESPOT",
    1281925730: "IFCLINE",
    3092502836: "IFCLINESEGMENT2D",
    388784114: "IFCLINEARPLACEMENT",
    1154579445: "IFCLINEARPOSITIONINGELEMENT",
    2624227202: "IFCLOCALPLACEMENT",
    1008929658: "IFCLOOP",
    1425443689: "IFCMANIFOLDSOLIDBREP",
    3057273783: "IFCMAPCONVERSION",
    2347385850: "IFCMAPPEDITEM",
    1838606355: "IFCMATERIAL",
    1847130766: "IFCMATERIALCLASSIFICATIONRELATIONSHIP",
    3708119000: "IFCMATERIALCONSTITUENT",
    2852063980: "IFCMATERIALCONSTITUENTSET",
    760658860: "IFCMATERIALDEFINITION",
    2022407955: "IFCMATERIALDEFINITIONREPRESENTATION",
    248100487: "IFCMATERIALLAYER",
    3303938423: "IFCMATERIALLAYERSET",
    1303795690: "IFCMATERIALLAYERSETUSAGE",
    1847252529: "IFCMATERIALLAYERWITHOFFSETS",
    2199411900: "IFCMATERIALLIST",
    2235152071: "IFCMATERIALPROFILE",
    164193824: "IFCMATERIALPROFILESET",
    3079605661: "IFCMATERIALPROFILESETUSAGE",
    3404854881: "IFCMATERIALPROFILESETUSAGETAPERING",
    552965576: "IFCMATERIALPROFILEWITHOFFSETS",
    3265635763: "IFCMATERIALPROPERTIES",
    853536259: "IFCMATERIALRELATIONSHIP",
    1507914824: "IFCMATERIALUSAGEDEFINITION",
    2597039031: "IFCMEASUREWITHUNIT",
    377706215: "IFCMECHANICALFASTENER",
    2108223431: "IFCMECHANICALFASTENERTYPE",
    1437502449: "IFCMEDICALDEVICE",
    1114901282: "IFCMEDICALDEVICETYPE",
    1073191201: "IFCMEMBER",
    1911478936: "IFCMEMBERSTANDARDCASE",
    3181161470: "IFCMEMBERTYPE",
    3368373690: "IFCMETRIC",
    2998442950: "IFCMIRROREDPROFILEDEF",
    2706619895: "IFCMONETARYUNIT",
    2474470126: "IFCMOTORCONNECTION",
    977012517: "IFCMOTORCONNECTIONTYPE",
    1918398963: "IFCNAMEDUNIT",
    3888040117: "IFCOBJECT",
    219451334: "IFCOBJECTDEFINITION",
    3701648758: "IFCOBJECTPLACEMENT",
    2251480897: "IFCOBJECTIVE",
    4143007308: "IFCOCCUPANT",
    590820931: "IFCOFFSETCURVE",
    3388369263: "IFCOFFSETCURVE2D",
    3505215534: "IFCOFFSETCURVE3D",
    2485787929: "IFCOFFSETCURVEBYDISTANCES",
    2665983363: "IFCOPENSHELL",
    3588315303: "IFCOPENINGELEMENT",
    3079942009: "IFCOPENINGSTANDARDCASE",
    4251960020: "IFCORGANIZATION",
    1411181986: "IFCORGANIZATIONRELATIONSHIP",
    643959842: "IFCORIENTATIONEXPRESSION",
    1029017970: "IFCORIENTEDEDGE",
    144952367: "IFCOUTERBOUNDARYCURVE",
    3694346114: "IFCOUTLET",
    2837617999: "IFCOUTLETTYPE",
    1207048766: "IFCOWNERHISTORY",
    2529465313: "IFCPARAMETERIZEDPROFILEDEF",
    2519244187: "IFCPATH",
    1682466193: "IFCPCURVE",
    2382730787: "IFCPERFORMANCEHISTORY",
    3566463478: "IFCPERMEABLECOVERINGPROPERTIES",
    3327091369: "IFCPERMIT",
    2077209135: "IFCPERSON",
    101040310: "IFCPERSONANDORGANIZATION",
    3021840470: "IFCPHYSICALCOMPLEXQUANTITY",
    2483315170: "IFCPHYSICALQUANTITY",
    2226359599: "IFCPHYSICALSIMPLEQUANTITY",
    1687234759: "IFCPILE",
    1158309216: "IFCPILETYPE",
    310824031: "IFCPIPEFITTING",
    804291784: "IFCPIPEFITTINGTYPE",
    3612865200: "IFCPIPESEGMENT",
    4231323485: "IFCPIPESEGMENTTYPE",
    597895409: "IFCPIXELTEXTURE",
    2004835150: "IFCPLACEMENT",
    603570806: "IFCPLANARBOX",
    1663979128: "IFCPLANAREXTENT",
    220341763: "IFCPLANE",
    3171933400: "IFCPLATE",
    1156407060: "IFCPLATESTANDARDCASE",
    4017108033: "IFCPLATETYPE",
    2067069095: "IFCPOINT",
    4022376103: "IFCPOINTONCURVE",
    1423911732: "IFCPOINTONSURFACE",
    2924175390: "IFCPOLYLOOP",
    2775532180: "IFCPOLYGONALBOUNDEDHALFSPACE",
    2839578677: "IFCPOLYGONALFACESET",
    3724593414: "IFCPOLYLINE",
    3740093272: "IFCPORT",
    1946335990: "IFCPOSITIONINGELEMENT",
    3355820592: "IFCPOSTALADDRESS",
    759155922: "IFCPREDEFINEDCOLOUR",
    2559016684: "IFCPREDEFINEDCURVEFONT",
    3727388367: "IFCPREDEFINEDITEM",
    3778827333: "IFCPREDEFINEDPROPERTIES",
    3967405729: "IFCPREDEFINEDPROPERTYSET",
    1775413392: "IFCPREDEFINEDTEXTFONT",
    677532197: "IFCPRESENTATIONITEM",
    2022622350: "IFCPRESENTATIONLAYERASSIGNMENT",
    1304840413: "IFCPRESENTATIONLAYERWITHSTYLE",
    3119450353: "IFCPRESENTATIONSTYLE",
    2417041796: "IFCPRESENTATIONSTYLEASSIGNMENT",
    2744685151: "IFCPROCEDURE",
    569719735: "IFCPROCEDURETYPE",
    2945172077: "IFCPROCESS",
    4208778838: "IFCPRODUCT",
    673634403: "IFCPRODUCTDEFINITIONSHAPE",
    2095639259: "IFCPRODUCTREPRESENTATION",
    3958567839: "IFCPROFILEDEF",
    2802850158: "IFCPROFILEPROPERTIES",
    103090709: "IFCPROJECT",
    653396225: "IFCPROJECTLIBRARY",
    2904328755: "IFCPROJECTORDER",
    3843373140: "IFCPROJECTEDCRS",
    3651124850: "IFCPROJECTIONELEMENT",
    2598011224: "IFCPROPERTY",
    986844984: "IFCPROPERTYABSTRACTION",
    871118103: "IFCPROPERTYBOUNDEDVALUE",
    1680319473: "IFCPROPERTYDEFINITION",
    148025276: "IFCPROPERTYDEPENDENCYRELATIONSHIP",
    4166981789: "IFCPROPERTYENUMERATEDVALUE",
    3710013099: "IFCPROPERTYENUMERATION",
    2752243245: "IFCPROPERTYLISTVALUE",
    941946838: "IFCPROPERTYREFERENCEVALUE",
    1451395588: "IFCPROPERTYSET",
    3357820518: "IFCPROPERTYSETDEFINITION",
    492091185: "IFCPROPERTYSETTEMPLATE",
    3650150729: "IFCPROPERTYSINGLEVALUE",
    110355661: "IFCPROPERTYTABLEVALUE",
    3521284610: "IFCPROPERTYTEMPLATE",
    1482703590: "IFCPROPERTYTEMPLATEDEFINITION",
    738039164: "IFCPROTECTIVEDEVICE",
    2295281155: "IFCPROTECTIVEDEVICETRIPPINGUNIT",
    655969474: "IFCPROTECTIVEDEVICETRIPPINGUNITTYPE",
    1842657554: "IFCPROTECTIVEDEVICETYPE",
    3219374653: "IFCPROXY",
    90941305: "IFCPUMP",
    2250791053: "IFCPUMPTYPE",
    2044713172: "IFCQUANTITYAREA",
    2093928680: "IFCQUANTITYCOUNT",
    931644368: "IFCQUANTITYLENGTH",
    2090586900: "IFCQUANTITYSET",
    3252649465: "IFCQUANTITYTIME",
    2405470396: "IFCQUANTITYVOLUME",
    825690147: "IFCQUANTITYWEIGHT",
    2262370178: "IFCRAILING",
    2893384427: "IFCRAILINGTYPE",
    3024970846: "IFCRAMP",
    3283111854: "IFCRAMPFLIGHT",
    2324767716: "IFCRAMPFLIGHTTYPE",
    1469900589: "IFCRAMPTYPE",
    1232101972: "IFCRATIONALBSPLINECURVEWITHKNOTS",
    683857671: "IFCRATIONALBSPLINESURFACEWITHKNOTS",
    2770003689: "IFCRECTANGLEHOLLOWPROFILEDEF",
    3615266464: "IFCRECTANGLEPROFILEDEF",
    2798486643: "IFCRECTANGULARPYRAMID",
    3454111270: "IFCRECTANGULARTRIMMEDSURFACE",
    3915482550: "IFCRECURRENCEPATTERN",
    2433181523: "IFCREFERENCE",
    4021432810: "IFCREFERENT",
    3413951693: "IFCREGULARTIMESERIES",
    1580146022: "IFCREINFORCEMENTBARPROPERTIES",
    3765753017: "IFCREINFORCEMENTDEFINITIONPROPERTIES",
    979691226: "IFCREINFORCINGBAR",
    2572171363: "IFCREINFORCINGBARTYPE",
    3027567501: "IFCREINFORCINGELEMENT",
    964333572: "IFCREINFORCINGELEMENTTYPE",
    2320036040: "IFCREINFORCINGMESH",
    2310774935: "IFCREINFORCINGMESHTYPE",
    160246688: "IFCRELAGGREGATES",
    3939117080: "IFCRELASSIGNS",
    1683148259: "IFCRELASSIGNSTOACTOR",
    2495723537: "IFCRELASSIGNSTOCONTROL",
    1307041759: "IFCRELASSIGNSTOGROUP",
    1027710054: "IFCRELASSIGNSTOGROUPBYFACTOR",
    4278684876: "IFCRELASSIGNSTOPROCESS",
    2857406711: "IFCRELASSIGNSTOPRODUCT",
    205026976: "IFCRELASSIGNSTORESOURCE",
    1865459582: "IFCRELASSOCIATES",
    4095574036: "IFCRELASSOCIATESAPPROVAL",
    919958153: "IFCRELASSOCIATESCLASSIFICATION",
    2728634034: "IFCRELASSOCIATESCONSTRAINT",
    982818633: "IFCRELASSOCIATESDOCUMENT",
    3840914261: "IFCRELASSOCIATESLIBRARY",
    2655215786: "IFCRELASSOCIATESMATERIAL",
    826625072: "IFCRELCONNECTS",
    1204542856: "IFCRELCONNECTSELEMENTS",
    3945020480: "IFCRELCONNECTSPATHELEMENTS",
    4201705270: "IFCRELCONNECTSPORTTOELEMENT",
    3190031847: "IFCRELCONNECTSPORTS",
    2127690289: "IFCRELCONNECTSSTRUCTURALACTIVITY",
    1638771189: "IFCRELCONNECTSSTRUCTURALMEMBER",
    504942748: "IFCRELCONNECTSWITHECCENTRICITY",
    3678494232: "IFCRELCONNECTSWITHREALIZINGELEMENTS",
    3242617779: "IFCRELCONTAINEDINSPATIALSTRUCTURE",
    886880790: "IFCRELCOVERSBLDGELEMENTS",
    2802773753: "IFCRELCOVERSSPACES",
    2565941209: "IFCRELDECLARES",
    2551354335: "IFCRELDECOMPOSES",
    693640335: "IFCRELDEFINES",
    1462361463: "IFCRELDEFINESBYOBJECT",
    4186316022: "IFCRELDEFINESBYPROPERTIES",
    307848117: "IFCRELDEFINESBYTEMPLATE",
    781010003: "IFCRELDEFINESBYTYPE",
    3940055652: "IFCRELFILLSELEMENT",
    279856033: "IFCRELFLOWCONTROLELEMENTS",
    427948657: "IFCRELINTERFERESELEMENTS",
    3268803585: "IFCRELNESTS",
    1441486842: "IFCRELPOSITIONS",
    750771296: "IFCRELPROJECTSELEMENT",
    1245217292: "IFCRELREFERENCEDINSPATIALSTRUCTURE",
    4122056220: "IFCRELSEQUENCE",
    366585022: "IFCRELSERVICESBUILDINGS",
    3451746338: "IFCRELSPACEBOUNDARY",
    3523091289: "IFCRELSPACEBOUNDARY1STLEVEL",
    1521410863: "IFCRELSPACEBOUNDARY2NDLEVEL",
    1401173127: "IFCRELVOIDSELEMENT",
    478536968: "IFCRELATIONSHIP",
    816062949: "IFCREPARAMETRISEDCOMPOSITECURVESEGMENT",
    1076942058: "IFCREPRESENTATION",
    3377609919: "IFCREPRESENTATIONCONTEXT",
    3008791417: "IFCREPRESENTATIONITEM",
    1660063152: "IFCREPRESENTATIONMAP",
    2914609552: "IFCRESOURCE",
    2943643501: "IFCRESOURCEAPPROVALRELATIONSHIP",
    1608871552: "IFCRESOURCECONSTRAINTRELATIONSHIP",
    2439245199: "IFCRESOURCELEVELRELATIONSHIP",
    1042787934: "IFCRESOURCETIME",
    1856042241: "IFCREVOLVEDAREASOLID",
    3243963512: "IFCREVOLVEDAREASOLIDTAPERED",
    4158566097: "IFCRIGHTCIRCULARCONE",
    3626867408: "IFCRIGHTCIRCULARCYLINDER",
    2016517767: "IFCROOF",
    2781568857: "IFCROOFTYPE",
    2341007311: "IFCROOT",
    2778083089: "IFCROUNDEDRECTANGLEPROFILEDEF",
    448429030: "IFCSIUNIT",
    3053780830: "IFCSANITARYTERMINAL",
    1768891740: "IFCSANITARYTERMINALTYPE",
    1054537805: "IFCSCHEDULINGTIME",
    2157484638: "IFCSEAMCURVE",
    2042790032: "IFCSECTIONPROPERTIES",
    4165799628: "IFCSECTIONREINFORCEMENTPROPERTIES",
    1862484736: "IFCSECTIONEDSOLID",
    1290935644: "IFCSECTIONEDSOLIDHORIZONTAL",
    1509187699: "IFCSECTIONEDSPINE",
    4086658281: "IFCSENSOR",
    1783015770: "IFCSENSORTYPE",
    1329646415: "IFCSHADINGDEVICE",
    4074543187: "IFCSHADINGDEVICETYPE",
    867548509: "IFCSHAPEASPECT",
    3982875396: "IFCSHAPEMODEL",
    4240577450: "IFCSHAPEREPRESENTATION",
    4124623270: "IFCSHELLBASEDSURFACEMODEL",
    3692461612: "IFCSIMPLEPROPERTY",
    3663146110: "IFCSIMPLEPROPERTYTEMPLATE",
    4097777520: "IFCSITE",
    1529196076: "IFCSLAB",
    3127900445: "IFCSLABELEMENTEDCASE",
    3027962421: "IFCSLABSTANDARDCASE",
    2533589738: "IFCSLABTYPE",
    2609359061: "IFCSLIPPAGECONNECTIONCONDITION",
    3420628829: "IFCSOLARDEVICE",
    1072016465: "IFCSOLARDEVICETYPE",
    723233188: "IFCSOLIDMODEL",
    3856911033: "IFCSPACE",
    1999602285: "IFCSPACEHEATER",
    1305183839: "IFCSPACEHEATERTYPE",
    3812236995: "IFCSPACETYPE",
    1412071761: "IFCSPATIALELEMENT",
    710998568: "IFCSPATIALELEMENTTYPE",
    2706606064: "IFCSPATIALSTRUCTUREELEMENT",
    3893378262: "IFCSPATIALSTRUCTUREELEMENTTYPE",
    463610769: "IFCSPATIALZONE",
    2481509218: "IFCSPATIALZONETYPE",
    451544542: "IFCSPHERE",
    4015995234: "IFCSPHERICALSURFACE",
    1404847402: "IFCSTACKTERMINAL",
    3112655638: "IFCSTACKTERMINALTYPE",
    331165859: "IFCSTAIR",
    4252922144: "IFCSTAIRFLIGHT",
    1039846685: "IFCSTAIRFLIGHTTYPE",
    338393293: "IFCSTAIRTYPE",
    682877961: "IFCSTRUCTURALACTION",
    3544373492: "IFCSTRUCTURALACTIVITY",
    2515109513: "IFCSTRUCTURALANALYSISMODEL",
    1179482911: "IFCSTRUCTURALCONNECTION",
    2273995522: "IFCSTRUCTURALCONNECTIONCONDITION",
    1004757350: "IFCSTRUCTURALCURVEACTION",
    4243806635: "IFCSTRUCTURALCURVECONNECTION",
    214636428: "IFCSTRUCTURALCURVEMEMBER",
    2445595289: "IFCSTRUCTURALCURVEMEMBERVARYING",
    2757150158: "IFCSTRUCTURALCURVEREACTION",
    3136571912: "IFCSTRUCTURALITEM",
    1807405624: "IFCSTRUCTURALLINEARACTION",
    2162789131: "IFCSTRUCTURALLOAD",
    385403989: "IFCSTRUCTURALLOADCASE",
    3478079324: "IFCSTRUCTURALLOADCONFIGURATION",
    1252848954: "IFCSTRUCTURALLOADGROUP",
    1595516126: "IFCSTRUCTURALLOADLINEARFORCE",
    609421318: "IFCSTRUCTURALLOADORRESULT",
    2668620305: "IFCSTRUCTURALLOADPLANARFORCE",
    2473145415: "IFCSTRUCTURALLOADSINGLEDISPLACEMENT",
    1973038258: "IFCSTRUCTURALLOADSINGLEDISPLACEMENTDISTORTION",
    1597423693: "IFCSTRUCTURALLOADSINGLEFORCE",
    1190533807: "IFCSTRUCTURALLOADSINGLEFORCEWARPING",
    2525727697: "IFCSTRUCTURALLOADSTATIC",
    3408363356: "IFCSTRUCTURALLOADTEMPERATURE",
    530289379: "IFCSTRUCTURALMEMBER",
    1621171031: "IFCSTRUCTURALPLANARACTION",
    2082059205: "IFCSTRUCTURALPOINTACTION",
    734778138: "IFCSTRUCTURALPOINTCONNECTION",
    1235345126: "IFCSTRUCTURALPOINTREACTION",
    3689010777: "IFCSTRUCTURALREACTION",
    2986769608: "IFCSTRUCTURALRESULTGROUP",
    3657597509: "IFCSTRUCTURALSURFACEACTION",
    1975003073: "IFCSTRUCTURALSURFACECONNECTION",
    3979015343: "IFCSTRUCTURALSURFACEMEMBER",
    2218152070: "IFCSTRUCTURALSURFACEMEMBERVARYING",
    603775116: "IFCSTRUCTURALSURFACEREACTION",
    2830218821: "IFCSTYLEMODEL",
    3958052878: "IFCSTYLEDITEM",
    3049322572: "IFCSTYLEDREPRESENTATION",
    148013059: "IFCSUBCONTRACTRESOURCE",
    4095615324: "IFCSUBCONTRACTRESOURCETYPE",
    2233826070: "IFCSUBEDGE",
    2513912981: "IFCSURFACE",
    699246055: "IFCSURFACECURVE",
    2028607225: "IFCSURFACECURVESWEPTAREASOLID",
    3101698114: "IFCSURFACEFEATURE",
    2809605785: "IFCSURFACEOFLINEAREXTRUSION",
    4124788165: "IFCSURFACEOFREVOLUTION",
    2934153892: "IFCSURFACEREINFORCEMENTAREA",
    1300840506: "IFCSURFACESTYLE",
    3303107099: "IFCSURFACESTYLELIGHTING",
    1607154358: "IFCSURFACESTYLEREFRACTION",
    1878645084: "IFCSURFACESTYLERENDERING",
    846575682: "IFCSURFACESTYLESHADING",
    1351298697: "IFCSURFACESTYLEWITHTEXTURES",
    626085974: "IFCSURFACETEXTURE",
    2247615214: "IFCSWEPTAREASOLID",
    1260650574: "IFCSWEPTDISKSOLID",
    1096409881: "IFCSWEPTDISKSOLIDPOLYGONAL",
    230924584: "IFCSWEPTSURFACE",
    1162798199: "IFCSWITCHINGDEVICE",
    2315554128: "IFCSWITCHINGDEVICETYPE",
    2254336722: "IFCSYSTEM",
    413509423: "IFCSYSTEMFURNITUREELEMENT",
    1580310250: "IFCSYSTEMFURNITUREELEMENTTYPE",
    3071757647: "IFCTSHAPEPROFILEDEF",
    985171141: "IFCTABLE",
    2043862942: "IFCTABLECOLUMN",
    531007025: "IFCTABLEROW",
    812556717: "IFCTANK",
    5716631: "IFCTANKTYPE",
    3473067441: "IFCTASK",
    1549132990: "IFCTASKTIME",
    2771591690: "IFCTASKTIMERECURRING",
    3206491090: "IFCTASKTYPE",
    912023232: "IFCTELECOMADDRESS",
    3824725483: "IFCTENDON",
    2347447852: "IFCTENDONANCHOR",
    3081323446: "IFCTENDONANCHORTYPE",
    3663046924: "IFCTENDONCONDUIT",
    2281632017: "IFCTENDONCONDUITTYPE",
    2415094496: "IFCTENDONTYPE",
    2387106220: "IFCTESSELLATEDFACESET",
    901063453: "IFCTESSELLATEDITEM",
    4282788508: "IFCTEXTLITERAL",
    3124975700: "IFCTEXTLITERALWITHEXTENT",
    1447204868: "IFCTEXTSTYLE",
    1983826977: "IFCTEXTSTYLEFONTMODEL",
    2636378356: "IFCTEXTSTYLEFORDEFINEDFONT",
    1640371178: "IFCTEXTSTYLETEXTMODEL",
    280115917: "IFCTEXTURECOORDINATE",
    1742049831: "IFCTEXTURECOORDINATEGENERATOR",
    2552916305: "IFCTEXTUREMAP",
    1210645708: "IFCTEXTUREVERTEX",
    3611470254: "IFCTEXTUREVERTEXLIST",
    1199560280: "IFCTIMEPERIOD",
    3101149627: "IFCTIMESERIES",
    581633288: "IFCTIMESERIESVALUE",
    1377556343: "IFCTOPOLOGICALREPRESENTATIONITEM",
    1735638870: "IFCTOPOLOGYREPRESENTATION",
    1935646853: "IFCTOROIDALSURFACE",
    3825984169: "IFCTRANSFORMER",
    1692211062: "IFCTRANSFORMERTYPE",
    2595432518: "IFCTRANSITIONCURVESEGMENT2D",
    1620046519: "IFCTRANSPORTELEMENT",
    2097647324: "IFCTRANSPORTELEMENTTYPE",
    2715220739: "IFCTRAPEZIUMPROFILEDEF",
    2916149573: "IFCTRIANGULATEDFACESET",
    1229763772: "IFCTRIANGULATEDIRREGULARNETWORK",
    3593883385: "IFCTRIMMEDCURVE",
    3026737570: "IFCTUBEBUNDLE",
    1600972822: "IFCTUBEBUNDLETYPE",
    1628702193: "IFCTYPEOBJECT",
    3736923433: "IFCTYPEPROCESS",
    2347495698: "IFCTYPEPRODUCT",
    3698973494: "IFCTYPERESOURCE",
    427810014: "IFCUSHAPEPROFILEDEF",
    180925521: "IFCUNITASSIGNMENT",
    630975310: "IFCUNITARYCONTROLELEMENT",
    3179687236: "IFCUNITARYCONTROLELEMENTTYPE",
    4292641817: "IFCUNITARYEQUIPMENT",
    1911125066: "IFCUNITARYEQUIPMENTTYPE",
    4207607924: "IFCVALVE",
    728799441: "IFCVALVETYPE",
    1417489154: "IFCVECTOR",
    2799835756: "IFCVERTEX",
    2759199220: "IFCVERTEXLOOP",
    1907098498: "IFCVERTEXPOINT",
    1530820697: "IFCVIBRATIONDAMPER",
    3956297820: "IFCVIBRATIONDAMPERTYPE",
    2391383451: "IFCVIBRATIONISOLATOR",
    3313531582: "IFCVIBRATIONISOLATORTYPE",
    2769231204: "IFCVIRTUALELEMENT",
    891718957: "IFCVIRTUALGRIDINTERSECTION",
    926996030: "IFCVOIDINGFEATURE",
    2391406946: "IFCWALL",
    4156078855: "IFCWALLELEMENTEDCASE",
    3512223829: "IFCWALLSTANDARDCASE",
    1898987631: "IFCWALLTYPE",
    4237592921: "IFCWASTETERMINAL",
    1133259667: "IFCWASTETERMINALTYPE",
    3304561284: "IFCWINDOW",
    336235671: "IFCWINDOWLININGPROPERTIES",
    512836454: "IFCWINDOWPANELPROPERTIES",
    486154966: "IFCWINDOWSTANDARDCASE",
    1299126871: "IFCWINDOWSTYLE",
    4009809668: "IFCWINDOWTYPE",
    4088093105: "IFCWORKCALENDAR",
    1028945134: "IFCWORKCONTROL",
    4218914973: "IFCWORKPLAN",
    3342526732: "IFCWORKSCHEDULE",
    1236880293: "IFCWORKTIME",
    2543172580: "IFCZSHAPEPROFILEDEF",
    1033361043: "IFCZONE",
};

class JSONPropertyManager extends BasePropertyManager {

    async getItemProperties(modelID, id, recursive = false) {
        return {
            ...this.state.models[modelID].jsonData[id]
        };
    }

    async getSpatialStructure(modelID, includeProperties) {
        const chunks = await this.getSpatialTreeChunks(modelID);
        const projectsIDs = await this.getAllItemsOfType(modelID, IFCPROJECT, false);
        const projectID = projectsIDs[0];
        const project = JSONPropertyManager.newIfcProject(projectID);
        await this.getSpatialNode(modelID, project, chunks, includeProperties);
        return {
            ...project
        };
    }

    async getAllItemsOfType(modelID, type, verbose) {
        const data = this.state.models[modelID].jsonData;
        const typeName = IfcTypesMap[type];
        if (!typeName) {
            throw new Error(`Type not found: ${type}`);
        }
        return this.filterItemsByType(data, typeName, verbose);
    }

    async getProperty(modelID, elementID, recursive = false, propName) {
        const resultIDs = await this.getAllRelatedItemsOfType(modelID, elementID, propName);
        const result = this.getItemsByID(modelID, resultIDs);
        if (recursive) {
            result.forEach(result => this.getReferencesRecursively(modelID, result));
        }
        return result;
    }

    getNodeType(modelID, id) {
        return this.state.models[modelID].jsonData[id].type;
    }

    async getChunks(modelID, chunks, propNames) {
        const relation = await this.getAllItemsOfType(modelID, propNames.name, true);
        relation.forEach(rel => {
            this.saveChunk(chunks, propNames, rel);
        });
    }

    filterItemsByType(data, typeName, verbose) {
        const result = [];
        Object.keys(data).forEach(key => {
            const numKey = parseInt(key);
            if (data[numKey].type.toUpperCase() === typeName) {
                result.push(verbose ? {
                    ...data[numKey]
                } : numKey);
            }
        });
        return result;
    }

    async getAllRelatedItemsOfType(modelID, id, propNames) {
        const lines = await this.getAllItemsOfType(modelID, propNames.name, true);
        const IDs = [];
        lines.forEach(line => {
            const isRelated = JSONPropertyManager.isRelated(id, line, propNames);
            if (isRelated)
                this.getRelated(line, propNames, IDs);
        });
        return IDs;
    }

    getItemsByID(modelID, ids) {
        const data = this.state.models[modelID].jsonData;
        const result = [];
        ids.forEach(id => result.push({
            ...data[id]
        }));
        return result;
    }

    getReferencesRecursively(modelID, jsonObject) {
        if (jsonObject == undefined)
            return;
        const keys = Object.keys(jsonObject);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            this.getJSONItem(modelID, jsonObject, key);
        }
    }

    getJSONItem(modelID, jsonObject, key) {
        if (Array.isArray(jsonObject[key])) {
            return this.getMultipleJSONItems(modelID, jsonObject, key);
        }
        if (jsonObject[key] && jsonObject[key].type === 5) {
            jsonObject[key] = this.getItemsByID(modelID, [jsonObject[key].value])[0];
            this.getReferencesRecursively(modelID, jsonObject[key]);
        }
    }

    getMultipleJSONItems(modelID, jsonObject, key) {
        jsonObject[key] = jsonObject[key].map((item) => {
            if (item.type === 5) {
                item = this.getItemsByID(modelID, [item.value])[0];
                this.getReferencesRecursively(modelID, item);
            }
            return item;
        });
    }

}

class PropertyManager {

    constructor(state) {
        this.state = state;
        this.webIfcProps = new WebIfcPropertyManager(state);
        this.jsonProps = new JSONPropertyManager(state);
        this.currentProps = this.webIfcProps;
    }

    getExpressId(geometry, faceIndex) {
        if (!geometry.index)
            throw new Error('Geometry does not have index information.');
        const geoIndex = geometry.index.array;
        return geometry.attributes[IdAttrName].getX(geoIndex[3 * faceIndex]);
    }

    async getItemProperties(modelID, elementID, recursive = false) {
        this.updateCurrentProps();
        return this.currentProps.getItemProperties(modelID, elementID, recursive);
    }

    async getAllItemsOfType(modelID, type, verbose) {
        this.updateCurrentProps();
        return this.currentProps.getAllItemsOfType(modelID, type, verbose);
    }

    async getPropertySets(modelID, elementID, recursive = false) {
        this.updateCurrentProps();
        return this.currentProps.getPropertySets(modelID, elementID, recursive);
    }

    async getTypeProperties(modelID, elementID, recursive = false) {
        this.updateCurrentProps();
        return this.currentProps.getTypeProperties(modelID, elementID, recursive);
    }

    async getMaterialsProperties(modelID, elementID, recursive = false) {
        this.updateCurrentProps();
        return this.currentProps.getMaterialsProperties(modelID, elementID, recursive);
    }

    async getSpatialStructure(modelID, includeProperties) {
        this.updateCurrentProps();
        if (!this.state.useJSON && includeProperties) {
            console.warn('Including properties in getSpatialStructure with the JSON workflow disabled can lead to poor performance.');
        }
        return await this.currentProps.getSpatialStructure(modelID, includeProperties);
    }

    updateCurrentProps() {
        this.currentProps = this.state.useJSON ? this.jsonProps : this.webIfcProps;
    }

}

class TypeManager {

    constructor(state) {
        this.state = state;
        this.state = state;
    }

    async getAllTypes(worker) {
        for (let modelID in this.state.models) {
            if (this.state.models.hasOwnProperty(modelID)) {
                const types = this.state.models[modelID].types;
                if (Object.keys(types).length == 0) {
                    await this.getAllTypesOfModel(parseInt(modelID), worker);
                }
            }
        }
    }

    async getAllTypesOfModel(modelID, worker) {
        const result = {};
        const elements = Object.keys(IfcElements).map((e) => parseInt(e));
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            const lines = await this.state.api.GetLineIDsWithType(modelID, element);
            const size = lines.size();
            for (let i = 0; i < size; i++)
                result[lines.get(i)] = element;
        }
        if (this.state.worker.active && worker) {
            await worker.workerState.updateModelStateTypes(modelID, result);
        }
        this.state.models[modelID].types = result;
    }

}

class BvhManager {

    initializeMeshBVH(computeBoundsTree, disposeBoundsTree, acceleratedRaycast) {
        this.computeBoundsTree = computeBoundsTree;
        this.disposeBoundsTree = disposeBoundsTree;
        this.acceleratedRaycast = acceleratedRaycast;
        this.setupThreeMeshBVH();
    }

    applyThreeMeshBVH(geometry) {
        if (this.computeBoundsTree)
            geometry.computeBoundsTree();
    }

    setupThreeMeshBVH() {
        if (!this.computeBoundsTree || !this.disposeBoundsTree || !this.acceleratedRaycast)
            return;
        BufferGeometry.prototype.computeBoundsTree = this.computeBoundsTree;
        BufferGeometry.prototype.disposeBoundsTree = this.disposeBoundsTree;
        Mesh.prototype.raycast = this.acceleratedRaycast;
    }

}

var WorkerActions;
(function (WorkerActions) {
    WorkerActions["updateStateUseJson"] = "updateStateUseJson";
    WorkerActions["updateStateWebIfcSettings"] = "updateStateWebIfcSettings";
    WorkerActions["updateModelStateTypes"] = "updateModelStateTypes";
    WorkerActions["updateModelStateJsonData"] = "updateModelStateJsonData";
    WorkerActions["loadJsonDataFromWorker"] = "loadJsonDataFromWorker";
    WorkerActions["dispose"] = "dispose";
    WorkerActions["Close"] = "Close";
    WorkerActions["DisposeWebIfc"] = "DisposeWebIfc";
    WorkerActions["Init"] = "Init";
    WorkerActions["OpenModel"] = "OpenModel";
    WorkerActions["CreateModel"] = "CreateModel";
    WorkerActions["ExportFileAsIFC"] = "ExportFileAsIFC";
    WorkerActions["GetGeometry"] = "GetGeometry";
    WorkerActions["GetLine"] = "GetLine";
    WorkerActions["GetAndClearErrors"] = "GetAndClearErrors";
    WorkerActions["WriteLine"] = "WriteLine";
    WorkerActions["FlattenLine"] = "FlattenLine";
    WorkerActions["GetRawLineData"] = "GetRawLineData";
    WorkerActions["WriteRawLineData"] = "WriteRawLineData";
    WorkerActions["GetLineIDsWithType"] = "GetLineIDsWithType";
    WorkerActions["GetAllLines"] = "GetAllLines";
    WorkerActions["SetGeometryTransformation"] = "SetGeometryTransformation";
    WorkerActions["GetCoordinationMatrix"] = "GetCoordinationMatrix";
    WorkerActions["GetVertexArray"] = "GetVertexArray";
    WorkerActions["GetIndexArray"] = "GetIndexArray";
    WorkerActions["getSubArray"] = "getSubArray";
    WorkerActions["CloseModel"] = "CloseModel";
    WorkerActions["StreamAllMeshes"] = "StreamAllMeshes";
    WorkerActions["StreamAllMeshesWithTypes"] = "StreamAllMeshesWithTypes";
    WorkerActions["IsModelOpen"] = "IsModelOpen";
    WorkerActions["LoadAllGeometry"] = "LoadAllGeometry";
    WorkerActions["GetFlatMesh"] = "GetFlatMesh";
    WorkerActions["SetWasmPath"] = "SetWasmPath";
    WorkerActions["parse"] = "parse";
    WorkerActions["setupOptionalCategories"] = "setupOptionalCategories";
    WorkerActions["getExpressId"] = "getExpressId";
    WorkerActions["initializeProperties"] = "initializeProperties";
    WorkerActions["getAllItemsOfType"] = "getAllItemsOfType";
    WorkerActions["getItemProperties"] = "getItemProperties";
    WorkerActions["getMaterialsProperties"] = "getMaterialsProperties";
    WorkerActions["getPropertySets"] = "getPropertySets";
    WorkerActions["getSpatialStructure"] = "getSpatialStructure";
    WorkerActions["getTypeProperties"] = "getTypeProperties";
})(WorkerActions || (WorkerActions = {}));
var WorkerAPIs;
(function (WorkerAPIs) {
    WorkerAPIs["workerState"] = "workerState";
    WorkerAPIs["webIfc"] = "webIfc";
    WorkerAPIs["properties"] = "properties";
    WorkerAPIs["parser"] = "parser";
})(WorkerAPIs || (WorkerAPIs = {}));

class Vector {

    constructor(vector) {
        this._data = {};
        this._size = vector.size;
        const keys = Object.keys(vector).filter((key) => key.indexOf('size') === -1).map(key => parseInt(key));
        keys.forEach((key) => this._data[key] = vector[key]);
    }

    size() {
        return this._size;
    }

    get(index) {
        return this._data[index];
    }

}

class IfcGeometry {

    constructor(vector) {
        this._GetVertexData = vector.GetVertexData;
        this._GetVertexDataSize = vector.GetVertexDataSize;
        this._GetIndexData = vector.GetIndexData;
        this._GetIndexDataSize = vector.GetIndexDataSize;
    }

    GetVertexData() {
        return this._GetVertexData;
    }

    GetVertexDataSize() {
        return this._GetVertexDataSize;
    }

    GetIndexData() {
        return this._GetIndexData;
    }

    GetIndexDataSize() {
        return this._GetIndexDataSize;
    }

}

class FlatMesh {

    constructor(serializer, flatMesh) {
        this.expressID = flatMesh.expressID;
        this.geometries = serializer.reconstructVector(flatMesh.geometries);
    }

}

class FlatMeshVector {

    constructor(serializer, vector) {
        this._data = {};
        this._size = vector.size;
        const keys = Object.keys(vector).filter((key) => key.indexOf('size') === -1).map(key => parseInt(key));
        keys.forEach(key => this._data[key] = serializer.reconstructFlatMesh(vector[key]));
    }

    size() {
        return this._size;
    }

    get(index) {
        return this._data[index];
    }

}

class SerializedMaterial {

    constructor(material) {
        this.color = [material.color.r, material.color.g, material.color.b];
        this.opacity = material.opacity;
        this.transparent = material.transparent;
    }

}

class MaterialReconstructor {

    static new(material) {
        return new MeshLambertMaterial({
            color: new Color(material.color[0], material.color[1], material.color[2]),
            opacity: material.opacity,
            transparent: material.transparent,
            side: DoubleSide
        });
    }

}

class SerializedGeometry {

    constructor(geometry) {
        var _a,
            _b,
            _c,
            _d;
        this.position = ((_a = geometry.attributes.position) === null || _a === void 0 ? void 0 : _a.array) || [];
        this.normal = ((_b = geometry.attributes.normal) === null || _b === void 0 ? void 0 : _b.array) || [];
        this.expressID = ((_c = geometry.attributes.expressID) === null || _c === void 0 ? void 0 : _c.array) || [];
        this.index = ((_d = geometry.index) === null || _d === void 0 ? void 0 : _d.array) || [];
        this.groups = geometry.groups;
    }

}

class GeometryReconstructor {

    static new(serialized) {
        const geom = new BufferGeometry();
        GeometryReconstructor.set(geom, 'expressID', new Uint32Array(serialized.expressID), 1);
        GeometryReconstructor.set(geom, 'position', new Float32Array(serialized.position), 3);
        GeometryReconstructor.set(geom, 'normal', new Float32Array(serialized.normal), 3);
        geom.setIndex(Array.from(serialized.index));
        geom.groups = serialized.groups;
        return geom;
    }

    static set(geom, name, data, size) {
        if (data.length > 0) {
            geom.setAttribute(name, new BufferAttribute(data, size));
        }
    }

}

class SerializedMesh {

    constructor(model) {
        this.materials = [];
        this.modelID = model.modelID;
        this.geometry = new SerializedGeometry(model.geometry);
        if (Array.isArray(model.material)) {
            model.material.forEach(mat => {
                this.materials.push(new SerializedMaterial(mat));
            });
        } else {
            this.materials.push(new SerializedMaterial(model.material));
        }
    }

}

class MeshReconstructor {

    static new(serialized) {
        const model = new IFCModel();
        model.modelID = serialized.modelID;
        model.geometry = GeometryReconstructor.new(serialized.geometry);
        MeshReconstructor.getMaterials(serialized, model);
        return model;
    }

    static getMaterials(serialized, model) {
        model.material = [];
        const mats = model.material;
        serialized.materials.forEach(mat => {
            mats.push(MaterialReconstructor.new(mat));
        });
    }

}

class Serializer {

    serializeVector(vector) {
        const size = vector.size();
        const serialized = {
            size
        };
        for (let i = 0; i < size; i++) {
            serialized[i] = vector.get(i);
        }
        return serialized;
    }

    reconstructVector(vector) {
        return new Vector(vector);
    }

    serializeIfcGeometry(geometry) {
        const GetVertexData = geometry.GetVertexData();
        const GetVertexDataSize = geometry.GetVertexDataSize();
        const GetIndexData = geometry.GetIndexData();
        const GetIndexDataSize = geometry.GetIndexDataSize();
        return {
            GetVertexData,
            GetVertexDataSize,
            GetIndexData,
            GetIndexDataSize
        };
    }

    reconstructIfcGeometry(geometry) {
        return new IfcGeometry(geometry);
    }

    serializeFlatMesh(flatMesh) {
        return {
            expressID: flatMesh.expressID,
            geometries: this.serializeVector(flatMesh.geometries)
        };
    }

    reconstructFlatMesh(flatMesh) {
        return new FlatMesh(this, flatMesh);
    }

    serializeFlatMeshVector(vector) {
        const size = vector.size();
        const serialized = {
            size
        };
        for (let i = 0; i < size; i++) {
            const flatMesh = vector.get(i);
            serialized[i] = this.serializeFlatMesh(flatMesh);
        }
        return serialized;
    }

    reconstructFlatMeshVector(vector) {
        return new FlatMeshVector(this, vector);
    }

    serializeIfcModel(model) {
        return new SerializedMesh(model);
    }

    reconstructIfcModel(model) {
        return MeshReconstructor.new(model);
    }

}

class PropertyHandler {

    constructor(handler) {
        this.handler = handler;
        this.API = WorkerAPIs.properties;
    }

    getExpressId(geometry, faceIndex) {
        if (!geometry.index)
            throw new Error('Geometry does not have index information.');
        const geoIndex = geometry.index.array;
        return geometry.attributes[IdAttrName].getX(geoIndex[3 * faceIndex]);
    }

    getAllItemsOfType(modelID, type, verbose) {
        return this.handler.request(this.API, WorkerActions.getAllItemsOfType, {
            modelID,
            type,
            verbose
        });
    }

    getItemProperties(modelID, elementID, recursive) {
        return this.handler.request(this.API, WorkerActions.getItemProperties, {
            modelID,
            elementID,
            recursive
        });
    }

    getMaterialsProperties(modelID, elementID, recursive) {
        return this.handler.request(this.API, WorkerActions.getMaterialsProperties, {
            modelID,
            elementID,
            recursive
        });
    }

    getPropertySets(modelID, elementID, recursive) {
        return this.handler.request(this.API, WorkerActions.getPropertySets, {
            modelID,
            elementID,
            recursive
        });
    }

    getTypeProperties(modelID, elementID, recursive) {
        return this.handler.request(this.API, WorkerActions.getTypeProperties, {
            modelID,
            elementID,
            recursive
        });
    }

    getSpatialStructure(modelID, includeProperties) {
        return this.handler.request(this.API, WorkerActions.getSpatialStructure, {
            modelID,
            includeProperties
        });
    }

}

class WebIfcHandler {

    constructor(handler, serializer) {
        this.handler = handler;
        this.serializer = serializer;
        this.API = WorkerAPIs.webIfc;
    }

    async Init() {
        this.wasmModule = true;
        return this.handler.request(this.API, WorkerActions.Init);
    }

    async OpenModel(data, settings) {
        return this.handler.request(this.API, WorkerActions.OpenModel, {
            data,
            settings
        });
    }

    async CreateModel(settings) {
        return this.handler.request(this.API, WorkerActions.CreateModel, {
            settings
        });
    }

    async ExportFileAsIFC(modelID) {
        return this.handler.request(this.API, WorkerActions.ExportFileAsIFC, {
            modelID
        });
    }

    async GetGeometry(modelID, geometryExpressID) {
        this.handler.serializeHandlers[this.handler.requestID] = (geom) => {
            return this.serializer.reconstructIfcGeometry(geom);
        };
        return this.handler.request(this.API, WorkerActions.GetGeometry, {
            modelID,
            geometryExpressID
        });
    }

    async GetLine(modelID, expressID, flatten) {
        return this.handler.request(this.API, WorkerActions.GetLine, {
            modelID,
            expressID,
            flatten
        });
    }

    async GetAndClearErrors(modelID) {
        this.handler.serializeHandlers[this.handler.requestID] = (vector) => {
            return this.serializer.reconstructVector(vector);
        };
        return this.handler.request(this.API, WorkerActions.GetAndClearErrors, {
            modelID
        });
    }

    async WriteLine(modelID, lineObject) {
        return this.handler.request(this.API, WorkerActions.WriteLine, {
            modelID,
            lineObject
        });
    }

    async FlattenLine(modelID, line) {
        return this.handler.request(this.API, WorkerActions.FlattenLine, {
            modelID,
            line
        });
    }

    async GetRawLineData(modelID, expressID) {
        return this.handler.request(this.API, WorkerActions.GetRawLineData, {
            modelID,
            expressID
        });
    }

    async WriteRawLineData(modelID, data) {
        return this.handler.request(this.API, WorkerActions.WriteRawLineData, {
            modelID,
            data
        });
    }

    async GetLineIDsWithType(modelID, type) {
        this.handler.serializeHandlers[this.handler.requestID] = (vector) => {
            return this.serializer.reconstructVector(vector);
        };
        return this.handler.request(this.API, WorkerActions.GetLineIDsWithType, {
            modelID,
            type
        });
    }

    async GetAllLines(modelID) {
        this.handler.serializeHandlers[this.handler.requestID] = (vector) => {
            return this.serializer.reconstructVector(vector);
        };
        return this.handler.request(this.API, WorkerActions.GetAllLines, {
            modelID
        });
    }

    async SetGeometryTransformation(modelID, transformationMatrix) {
        return this.handler.request(this.API, WorkerActions.SetGeometryTransformation, {
            modelID,
            transformationMatrix
        });
    }

    async GetCoordinationMatrix(modelID) {
        return this.handler.request(this.API, WorkerActions.GetCoordinationMatrix, {
            modelID
        });
    }

    async GetVertexArray(ptr, size) {
        return this.handler.request(this.API, WorkerActions.GetVertexArray, {
            ptr,
            size
        });
    }

    async GetIndexArray(ptr, size) {
        return this.handler.request(this.API, WorkerActions.GetIndexArray, {
            ptr,
            size
        });
    }

    async getSubArray(heap, startPtr, sizeBytes) {
        return this.handler.request(this.API, WorkerActions.getSubArray, {
            heap,
            startPtr,
            sizeBytes
        });
    }

    async CloseModel(modelID) {
        return this.handler.request(this.API, WorkerActions.CloseModel, {
            modelID
        });
    }

    async StreamAllMeshes(modelID, meshCallback) {
        this.handler.callbackHandlers[this.handler.requestID] = {
            action: meshCallback,
            serializer: this.serializer.reconstructFlatMesh
        };
        return this.handler.request(this.API, WorkerActions.StreamAllMeshes, {
            modelID
        });
    }

    async StreamAllMeshesWithTypes(modelID, types, meshCallback) {
        this.handler.callbackHandlers[this.handler.requestID] = {
            action: meshCallback,
            serializer: this.serializer.reconstructFlatMesh
        };
        return this.handler.request(this.API, WorkerActions.StreamAllMeshesWithTypes, {
            modelID,
            types
        });
    }

    async IsModelOpen(modelID) {
        return this.handler.request(this.API, WorkerActions.IsModelOpen, {
            modelID
        });
    }

    async LoadAllGeometry(modelID) {
        this.handler.serializeHandlers[this.handler.requestID] = (vector) => {
            return this.serializer.reconstructFlatMeshVector(vector);
        };
        return this.handler.request(this.API, WorkerActions.LoadAllGeometry, {
            modelID
        });
    }

    async GetFlatMesh(modelID, expressID) {
        this.handler.serializeHandlers[this.handler.requestID] = (flatMesh) => {
            return this.serializer.reconstructFlatMesh(flatMesh);
        };
        return this.handler.request(this.API, WorkerActions.GetFlatMesh, {
            modelID,
            expressID
        });
    }

    async SetWasmPath(path) {
        return this.handler.request(this.API, WorkerActions.SetWasmPath, {
            path
        });
    }

}

class WorkerStateHandler {

    constructor(handler) {
        this.handler = handler;
        this.API = WorkerAPIs.workerState;
        this.state = this.handler.state;
    }

    async updateStateUseJson() {
        const useJson = this.state.useJSON;
        return this.handler.request(this.API, WorkerActions.updateStateUseJson, {
            useJson
        });
    }

    async updateStateWebIfcSettings() {
        const webIfcSettings = this.state.webIfcSettings;
        return this.handler.request(this.API, WorkerActions.updateStateWebIfcSettings, {
            webIfcSettings
        });
    }

    async updateModelStateTypes(modelID, types) {
        return this.handler.request(this.API, WorkerActions.updateModelStateTypes, {
            modelID,
            types
        });
    }

    async updateModelStateJsonData(modelID, jsonData) {
        return this.handler.request(this.API, WorkerActions.updateModelStateJsonData, {
            modelID,
            jsonData
        });
    }

    async loadJsonDataFromWorker(modelID, path) {
        return this.handler.request(this.API, WorkerActions.loadJsonDataFromWorker, {
            modelID,
            path
        });
    }

}

var DBOperation;
(function (DBOperation) {
    DBOperation[DBOperation["transferIfcModel"] = 0] = "transferIfcModel";
    DBOperation[DBOperation["transferIndividualItems"] = 1] = "transferIndividualItems";
})(DBOperation || (DBOperation = {}));

class IndexedDatabase {

    async save(item, id) {
        const open = IndexedDatabase.openOrCreateDB(id);
        this.createSchema(open, id);
        return new Promise((resolve, reject) => {
            open.onsuccess = () => this.saveItem(item, open, id, resolve);
        });
    }

    async load(id) {
        const open = IndexedDatabase.openOrCreateDB(id);
        return new Promise((resolve, reject) => {
            open.onsuccess = () => this.loadItem(open, id, resolve);
        });
    }

    createSchema(open, id) {
        open.onupgradeneeded = function () {
            const db = open.result;
            db.createObjectStore(id.toString(), {
                keyPath: "id"
            });
        };
    }

    saveItem(item, open, id, resolve) {
        const { db, tx, store } = IndexedDatabase.getDBItems(open, id);
        item.id = id;
        store.put(item);
        tx.oncomplete = () => IndexedDatabase.closeDB(db, tx, resolve);
    }

    loadItem(open, id, resolve) {
        const { db, tx, store } = IndexedDatabase.getDBItems(open, id);
        const item = store.get(id);
        const callback = () => {
            delete item.result.id;
            resolve(item.result);
        };
        tx.oncomplete = () => IndexedDatabase.closeDB(db, tx, callback);
    }

    static getDBItems(open, id) {
        const db = open.result;
        const tx = db.transaction(id.toString(), "readwrite");
        const store = tx.objectStore(id.toString());
        return {
            db,
            tx,
            store
        };
    }

    static openOrCreateDB(id) {
        return indexedDB.open(id.toString(), 1);
    }

    static closeDB(db, tx, resolve) {
        db.close();
        resolve("success");
    }

}

class ParserHandler {

    constructor(handler, serializer, BVH, IDB) {
        this.handler = handler;
        this.serializer = serializer;
        this.BVH = BVH;
        this.IDB = IDB;
        this.optionalCategories = {
            [IFCSPACE]: true,
            [IFCOPENINGELEMENT]: false
        };
        this.API = WorkerAPIs.parser;
    }

    async setupOptionalCategories(config) {
        this.optionalCategories = config;
        return this.handler.request(this.API, WorkerActions.setupOptionalCategories, {
            config
        });
    }

    async parse(buffer, coordinationMatrix) {
        this.handler.onprogressHandlers[this.handler.requestID] = (progress) => {
            if (this.handler.state.onProgress)
                this.handler.state.onProgress(progress);
        };
        this.handler.serializeHandlers[this.handler.requestID] = async (result) => {
            this.updateState(result.modelID);
            return this.getModel();
        };
        return this.handler.request(this.API, WorkerActions.parse, {
            buffer,
            coordinationMatrix
        });
    }

    getAndClearErrors(_modelId) { }

    updateState(modelID) {
        this.handler.state.models[modelID] = {
            modelID: modelID,
            mesh: {},
            types: {},
            jsonData: {}
        };
    }

    async getModel() {
        const serializedModel = await this.IDB.load(DBOperation.transferIfcModel);
        const model = this.serializer.reconstructIfcModel(serializedModel);
        this.BVH.applyThreeMeshBVH(model.geometry);
        this.handler.state.models[model.modelID].mesh = model;
        return model;
    }

}

class IFCWorkerHandler {

    constructor(state, BVH) {
        this.state = state;
        this.BVH = BVH;
        this.requestID = 0;
        this.rejectHandlers = {};
        this.resolveHandlers = {};
        this.serializeHandlers = {};
        this.callbackHandlers = {};
        this.onprogressHandlers = {};
        this.serializer = new Serializer();
        this.IDB = new IndexedDatabase();
        this.workerPath = this.state.worker.path;
        this.ifcWorker = new Worker(this.workerPath);
        this.ifcWorker.onmessage = (data) => this.handleResponse(data);
        this.properties = new PropertyHandler(this);
        this.parser = new ParserHandler(this, this.serializer, this.BVH, this.IDB);
        this.webIfc = new WebIfcHandler(this, this.serializer);
        this.workerState = new WorkerStateHandler(this);
    }

    request(worker, action, args) {
        const data = {
            worker,
            action,
            args,
            id: this.requestID,
            result: undefined,
            onProgress: false
        };
        return new Promise((resolve, reject) => {
            this.resolveHandlers[this.requestID] = resolve;
            this.rejectHandlers[this.requestID] = reject;
            this.requestID++;
            this.ifcWorker.postMessage(data);
        });
    }

    async terminate() {
        await this.request(WorkerAPIs.workerState, WorkerActions.dispose);
        await this.request(WorkerAPIs.webIfc, WorkerActions.DisposeWebIfc);
        this.ifcWorker.terminate();
    }

    async Close() {
        await this.request(WorkerAPIs.webIfc, WorkerActions.Close);
    }

    handleResponse(event) {
        const data = event.data;
        if (data.onProgress) {
            this.resolveOnProgress(data);
            return;
        }
        this.callHandlers(data);
        delete this.resolveHandlers[data.id];
        delete this.rejectHandlers[data.id];
        delete this.onprogressHandlers[data.id];
    }

    callHandlers(data) {
        try {
            this.resolveSerializations(data);
            this.resolveCallbacks(data);
            this.resolveHandlers[data.id](data.result);
        } catch (error) {
            this.rejectHandlers[data.id](error);
        }
    }

    resolveOnProgress(data) {
        if (this.onprogressHandlers[data.id]) {
            data.result = this.onprogressHandlers[data.id](data.result);
        }
    }

    resolveSerializations(data) {
        if (this.serializeHandlers[data.id]) {
            data.result = this.serializeHandlers[data.id](data.result);
            delete this.serializeHandlers[data.id];
        }
    }

    resolveCallbacks(data) {
        if (this.callbackHandlers[data.id]) {
            let callbackParameter = data.result;
            if (this.callbackHandlers[data.id].serializer) {
                callbackParameter = this.callbackHandlers[data.id].serializer(data.result);
            }
            this.callbackHandlers[data.id].action(callbackParameter);
        }
    }

}

class MemoryCleaner {

    constructor(state) {
        this.state = state;
    }

    async dispose() {
        Object.keys(this.state.models).forEach(modelID => {
            const model = this.state.models[parseInt(modelID, 10)];
            model.mesh.removeFromParent();
            const geom = model.mesh.geometry;
            if (geom.disposeBoundsTree)
                geom.disposeBoundsTree();
            geom.dispose();
            if (!Array.isArray(model.mesh.material))
                model.mesh.material.dispose();
            else
                model.mesh.material.forEach(mat => mat.dispose());
            model.mesh = null;
            model.types = null;
            model.jsonData = null;
        });
        this.state.api = null;
        this.state.models = null;
    }

}

class IFCUtils {

    constructor(state) {
        this.state = state;
        this.map = {};
    }

    getMapping() {
        this.map = this.reverseElementMapping(IfcTypesMap);
    }

    releaseMapping() {
        this.map = {};
    }

    reverseElementMapping(obj) {
        let reverseElement = {};
        Object.keys(obj).forEach(key => {
            reverseElement[obj[key]] = key;
        });
        return reverseElement;
    }

    isA(entity, entity_class) {
        var test = false;
        if (entity_class) {
            if (IfcTypesMap[entity.type] === entity_class.toUpperCase()) {
                test = true;
            }
            return test;
        } else {
            return IfcTypesMap[entity.type];
        }
    }

    async byId(modelID, id) {
        return this.state.api.GetLine(modelID, id);
    }

    async idsByType(modelID, entity_class) {
        this.getMapping();
        let entities_ids = await this.state.api.GetLineIDsWithType(modelID, Number(this.map[entity_class.toUpperCase()]));
        this.releaseMapping();
        return entities_ids;
    }

    async byType(modelID, entity_class) {
        let entities_ids = await this.idsByType(modelID, entity_class);
        if (entities_ids !== null) {
            this.getMapping();
            let items = [];
            for (let i = 0; i < entities_ids.size(); i++) {
                let entity = await this.byId(modelID, entities_ids.get(i));
                items.push(entity);
            }
            this.releaseMapping();
            return items;
        }
    }

}

class Data {

    constructor(state) {
        this.state = state;
        this.is_loaded = false;
        this.work_plans = {};
        this.workSchedules = {};
        this.work_calendars = {};
        this.work_times = {};
        this.recurrence_patterns = {};
        this.time_periods = {};
        this.tasks = {};
        this.task_times = {};
        this.lag_times = {};
        this.sequences = {};
        this.utils = new IFCUtils(this.state);
    }

    async load(modelID) {
        await this.loadTasks(modelID);
        this.loadWorkSchedules(modelID);
    }

    async loadWorkSchedules(modelID) {
        let workSchedules = await this.utils.byType(modelID, "IfcWorkSchedule");
        for (let i = 0; i < workSchedules.length; i++) {
            let workSchedule = workSchedules[i];
            this.workSchedules[workSchedule.expressID] = {
                "Id": workSchedule.expressID,
                "Name": workSchedule.Name.value,
                "Description": ((workSchedule.Description) ? workSchedule.Description.value : ""),
                "Creators": [],
                "CreationDate": ((workSchedule.CreationDate) ? workSchedule.CreationDate.value : ""),
                "StartTime": ((workSchedule.StartTime) ? workSchedule.StartTime.value : ""),
                "FinishTime": ((workSchedule.FinishTime) ? workSchedule.FinishTime.value : ""),
                "TotalFloat": ((workSchedule.TotalFloat) ? workSchedule.TotalFloat.value : ""),
                "RelatedObjects": [],
            };
        }
        this.loadWorkScheduleRelatedObjects(modelID);
    }

    async loadWorkScheduleRelatedObjects(modelID) {
        let relsControls = await this.utils.byType(modelID, "IfcRelAssignsToControl");
        console.log("Rel Controls:", relsControls);
        for (let i = 0; i < relsControls.length; i++) {
            let relControls = relsControls[i];
            let relatingControl = await this.utils.byId(modelID, relControls.RelatingControl.value);
            let relatedObjects = relControls.RelatedObjects;
            if (this.utils.isA(relatingControl, "IfcWorkSchedule")) {
                for (var objectIndex = 0; objectIndex < relatedObjects.length; objectIndex++) {
                    this.workSchedules[relatingControl.expressID]["RelatedObjects"].push(relatedObjects[objectIndex].value);
                }
            }
        }
    }

    async loadTasks(modelID) {
        let tasks = await this.utils.byType(modelID, "IfcTask");
        for (let i = 0; i < tasks.length; i++) {
            let task = tasks[i];
            this.tasks[task.expressID] = {
                "Id": task.expressID,
                "Name": task.Name.value,
                "TaskTime": ((task.TaskTime) ? await this.utils.byId(modelID, task.TaskTime.value) : ""),
                "Identification": task.Identification.value,
                "IsMilestone": task.IsMilestone.value,
                "IsPredecessorTo": [],
                "IsSucessorFrom": [],
                "Inputs": [],
                "Resources": [],
                "Outputs": [],
                "Controls": [],
                "Nests": [],
                "IsNestedBy": [],
                "OperatesOn": [],
            };
        }
        await this.loadTaskSequence(modelID);
        await this.loadTaskOutputs(modelID);
        await this.loadTaskNesting(modelID);
        await this.loadTaskOperations(modelID);
    }

    async loadTaskSequence(modelID) {
        let relsSequence = await this.utils.idsByType(modelID, "IfcRelSequence");
        for (let i = 0; i < relsSequence.size(); i++) {
            let relSequenceId = relsSequence.get(i);
            if (relSequenceId !== 0) {
                let relSequence = await this.utils.byId(modelID, relSequenceId);
                let related_process = relSequence.RelatedProcess.value;
                let relatingProcess = relSequence.RelatingProcess.value;
                this.tasks[relatingProcess]["IsPredecessorTo"].push(relSequence.expressID);
                let successorData = {
                    "RelId": relSequence.expressID,
                    "Rel": relSequence
                };
                this.tasks[related_process]["IsSucessorFrom"].push(successorData);
            }
        }
    }

    async loadTaskOutputs(modelID) {
        let rels_assigns_to_product = await this.utils.byType(modelID, "IfcRelAssignsToProduct");
        for (let i = 0; i < rels_assigns_to_product.length; i++) {
            let relAssignsToProduct = rels_assigns_to_product[i];
            let relatingProduct = await this.utils.byId(modelID, relAssignsToProduct.RelatingProduct.value);
            let relatedObject = await this.utils.byId(modelID, relAssignsToProduct.RelatedObjects[0].value);
            if (this.utils.isA(relatedObject, "IfcTask")) {
                this.tasks[relatedObject.expressID]["Outputs"].push(relatingProduct.expressID);
            }
        }
    }

    async loadTaskNesting(modelID) {
        let rels_nests = await this.utils.byType(modelID, "IfcRelNests");
        for (let i = 0; i < rels_nests.length; i++) {
            let relNests = rels_nests[i];
            let relating_object = await this.utils.byId(modelID, relNests.RelatingObject.value);
            let relatedObjects = relNests.RelatedObjects;
            if (this.utils.isA(relating_object, "IfcTask")) {
                for (var object_index = 0; object_index < relatedObjects.length; object_index++) {
                    this.tasks[relating_object.expressID]["IsNestedBy"].push(relatedObjects[object_index].value);
                    this.tasks[relatedObjects[object_index].value]["Nests"].push(relating_object.expressID);
                }
            }
        }
    }

    async loadTaskOperations(modelID) {
        let relsAssignsToProcess = await this.utils.byType(modelID, "IfcRelAssignsToProcess");
        for (let i = 0; i < relsAssignsToProcess.length; i++) {
            let relAssignToProcess = relsAssignsToProcess[i];
            let relatingProcess = await this.utils.byId(modelID, relAssignToProcess.RelatingProcess.value);
            let relatedObjects = relAssignToProcess.RelatedObjects;
            if (this.utils.isA(relatingProcess, "IfcTask")) {
                for (var object_index = 0; object_index < relatedObjects.length; object_index++) {
                    this.tasks[relatingProcess.expressID]["OperatesOn"].push(relatedObjects[object_index].value);
                    console.log(relatingProcess.expressID);
                    console.log("Has Operations");
                }
            }
        }
    }

}

class IFCManager {

    constructor() {
        this.state = {
            models: [],
            api: new WebIFC.IfcAPI(),
            useJSON: false,
            worker: {
                active: false,
                path: ''
            }
        };
        this.BVH = new BvhManager();
        this.typesMap = IfcTypesMap;
        this.parser = new IFCParser(this.state, this.BVH);
        this.subsets = new SubsetManager(this.state, this.BVH);
        this.utils = new IFCUtils(this.state);
        this.sequenceData = new Data(this.state);
        this.properties = new PropertyManager(this.state);
        this.types = new TypeManager(this.state);
        this.cleaner = new MemoryCleaner(this.state);
    }

    get ifcAPI() {
        return this.state.api;
    }

    async parse(buffer) {
        var _a;
        const model = await this.parser.parse(buffer, (_a = this.state.coordinationMatrix) === null || _a === void 0 ? void 0 : _a.toArray());
        model.setIFCManager(this);
        await this.types.getAllTypes(this.worker);
        return model;
    }

    async setWasmPath(path) {
        this.state.api.SetWasmPath(path);
        this.state.wasmPath = path;
    }

    setupThreeMeshBVH(computeBoundsTree, disposeBoundsTree, acceleratedRaycast) {
        this.BVH.initializeMeshBVH(computeBoundsTree, disposeBoundsTree, acceleratedRaycast);
    }

    setOnProgress(onProgress) {
        this.state.onProgress = onProgress;
    }

    setupCoordinationMatrix(matrix) {
        this.state.coordinationMatrix = matrix;
    }

    clearCoordinationMatrix() {
        delete this.state.coordinationMatrix;
    }

    async applyWebIfcConfig(settings) {
        this.state.webIfcSettings = settings;
        if (this.state.worker.active && this.worker) {
            await this.worker.workerState.updateStateWebIfcSettings();
        }
    }

    async useWebWorkers(active, path) {
        if (this.state.worker.active === active)
            return;
        this.state.api = null;
        if (active) {
            if (!path)
                throw new Error('You must provide a path to the web worker.');
            this.state.worker.active = active;
            this.state.worker.path = path;
            await this.initializeWorkers();
            const wasm = this.state.wasmPath;
            if (wasm)
                await this.setWasmPath(wasm);
        } else {
            this.state.api = new WebIFC.IfcAPI();
        }
    }

    async useJSONData(useJSON = true) {
        var _a;
        this.state.useJSON = useJSON;
        if (useJSON) {
            await ((_a = this.worker) === null || _a === void 0 ? void 0 : _a.workerState.updateStateUseJson());
        }
    }

    async addModelJSONData(modelID, data) {
        var _a;
        const model = this.state.models[modelID];
        if (!model)
            throw new Error('The specified model for the JSON data does not exist');
        if (this.state.worker.active) {
            await ((_a = this.worker) === null || _a === void 0 ? void 0 : _a.workerState.updateModelStateJsonData(modelID, data));
        } else {
            model.jsonData = data;
        }
    }

    async loadJsonDataFromWorker(modelID, path) {
        var _a;
        if (this.state.worker.active) {
            await ((_a = this.worker) === null || _a === void 0 ? void 0 : _a.workerState.loadJsonDataFromWorker(modelID, path));
        }
    }

    close(modelID, scene) {
        this.state.api.CloseModel(modelID);
        if (scene)
            scene.remove(this.state.models[modelID].mesh);
        delete this.state.models[modelID];
    }

    getExpressId(geometry, faceIndex) {
        return this.properties.getExpressId(geometry, faceIndex);
    }

    getAllItemsOfType(modelID, type, verbose) {
        return this.properties.getAllItemsOfType(modelID, type, verbose);
    }

    getItemProperties(modelID, id, recursive = false) {
        return this.properties.getItemProperties(modelID, id, recursive);
    }

    getPropertySets(modelID, id, recursive = false) {
        return this.properties.getPropertySets(modelID, id, recursive);
    }

    getTypeProperties(modelID, id, recursive = false) {
        return this.properties.getTypeProperties(modelID, id, recursive);
    }

    getMaterialsProperties(modelID, id, recursive = false) {
        return this.properties.getMaterialsProperties(modelID, id, recursive);
    }

    getIfcType(modelID, id) {
        const typeID = this.state.models[modelID].types[id];
        return IfcElements[typeID];
    }

    getSpatialStructure(modelID, includeProperties) {
        return this.properties.getSpatialStructure(modelID, includeProperties);
    }

    getSubset(modelID, material, customId) {
        return this.subsets.getSubset(modelID, material, customId);
    }

    removeSubset(modelID, material, customID) {
        this.subsets.removeSubset(modelID, material, customID);
    }

    createSubset(config) {
        return this.subsets.createSubset(config);
    }

    removeFromSubset(modelID, ids, customID, material) {
        return this.subsets.removeFromSubset(modelID, ids, customID, material);
    }

    clearSubset(modelID, customID, material) {
        return this.subsets.clearSubset(modelID, customID, material);
    }

    async isA(entity, entity_class) {
        return this.utils.isA(entity, entity_class);
    }

    async getSequenceData(modelID) {
        await this.sequenceData.load(modelID);
        return this.sequenceData;
    }

    async byType(modelID, entityClass) {
        return this.utils.byType(modelID, entityClass);
    }

    async byId(modelID, id) {
        return this.utils.byId(modelID, id);
    }

    async idsByType(modelID, entityClass) {
        return this.utils.idsByType(modelID, entityClass);
    }

    async dispose() {
        IFCModel.dispose();
        await this.cleaner.dispose();
        this.subsets.dispose();
        if (this.worker && this.state.worker.active)
            await this.worker.terminate();
        this.state = null;
    }

    async disposeMemory() {
        var _a;
        if (this.state.worker.active) {
            await ((_a = this.worker) === null || _a === void 0 ? void 0 : _a.Close());
        } else {
            this.state.api.Close();
            this.state.api = null;
            this.state.api = new WebIFC.IfcAPI();
        }
    }

    getAndClearErrors(modelID) {
        return this.parser.getAndClearErrors(modelID);
    }

    async initializeWorkers() {
        this.worker = new IFCWorkerHandler(this.state, this.BVH);
        this.state.api = this.worker.webIfc;
        this.properties = this.worker.properties;
        await this.worker.parser.setupOptionalCategories(this.parser.optionalCategories);
        this.parser = this.worker.parser;
        await this.worker.workerState.updateStateUseJson();
        await this.worker.workerState.updateStateWebIfcSettings();
    }

}

class IFCLoader extends Loader {

    constructor(manager) {
        super(manager);
        this.ifcManager = new IFCManager();
    }

    load(url, onLoad, onProgress, onError) {
        const scope = this;
        const loader = new FileLoader(scope.manager);
        this.onProgress = onProgress;
        loader.setPath(scope.path);
        loader.setResponseType('arraybuffer');
        loader.setRequestHeader(scope.requestHeader);
        loader.setWithCredentials(scope.withCredentials);
        loader.load(url, async function (buffer) {
            try {
                if (typeof buffer == 'string') {
                    throw new Error('IFC files must be given as a buffer!');
                }
                onLoad(await scope.parse(buffer));
            } catch (e) {
                if (onError) {
                    onError(e);
                } else {
                    console.error(e);
                }
                scope.manager.itemError(url);
            }
        }, onProgress, onError);
    }

    parse(buffer) {
        return this.ifcManager.parse(buffer);
    }

}

export { IFCLoader };
//# sourceMappingURL=IFCLoader.js.map