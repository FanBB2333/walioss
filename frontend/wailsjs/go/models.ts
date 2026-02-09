export namespace main {
	
	export class AppInfo {
	    name: string;
	    version: string;
	    githubUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.version = source["version"];
	        this.githubUrl = source["githubUrl"];
	    }
	}
	export class AppSettings {
	    ossutilPath: string;
	    workDir: string;
	    defaultRegion: string;
	    defaultEndpoint: string;
	    theme: string;
	    maxTransferThreads: number;
	    newTabNameRule: string;
	
	    static createFrom(source: any = {}) {
	        return new AppSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ossutilPath = source["ossutilPath"];
	        this.workDir = source["workDir"];
	        this.defaultRegion = source["defaultRegion"];
	        this.defaultEndpoint = source["defaultEndpoint"];
	        this.theme = source["theme"];
	        this.maxTransferThreads = source["maxTransferThreads"];
	        this.newTabNameRule = source["newTabNameRule"];
	    }
	}
	export class BucketInfo {
	    name: string;
	    region: string;
	    creationDate: string;
	
	    static createFrom(source: any = {}) {
	        return new BucketInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.region = source["region"];
	        this.creationDate = source["creationDate"];
	    }
	}
	export class ConnectionResult {
	    success: boolean;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	    }
	}
	export class OSSConfig {
	    accessKeyId: string;
	    accessKeySecret: string;
	    region: string;
	    endpoint: string;
	    defaultPath: string;
	
	    static createFrom(source: any = {}) {
	        return new OSSConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accessKeyId = source["accessKeyId"];
	        this.accessKeySecret = source["accessKeySecret"];
	        this.region = source["region"];
	        this.endpoint = source["endpoint"];
	        this.defaultPath = source["defaultPath"];
	    }
	}
	export class OSSProfile {
	    name: string;
	    config: OSSConfig;
	    isDefault: boolean;
	
	    static createFrom(source: any = {}) {
	        return new OSSProfile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.config = this.convertValues(source["config"], OSSConfig);
	        this.isDefault = source["isDefault"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ObjectInfo {
	    name: string;
	    path: string;
	    size: number;
	    type: string;
	    lastModified: string;
	    storageClass: string;
	
	    static createFrom(source: any = {}) {
	        return new ObjectInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.type = source["type"];
	        this.lastModified = source["lastModified"];
	        this.storageClass = source["storageClass"];
	    }
	}
	export class ObjectListPageResult {
	    items: ObjectInfo[];
	    nextMarker: string;
	    isTruncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ObjectListPageResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.items = this.convertValues(source["items"], ObjectInfo);
	        this.nextMarker = source["nextMarker"];
	        this.isTruncated = source["isTruncated"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TransferUpdate {
	    id: string;
	    profileName?: string;
	    type: string;
	    status: string;
	    name: string;
	    bucket: string;
	    key: string;
	    localPath?: string;
	    parentId?: string;
	    isGroup?: boolean;
	    fileCount?: number;
	    doneCount?: number;
	    successCount?: number;
	    errorCount?: number;
	    totalBytes?: number;
	    doneBytes?: number;
	    speedBytesPerSec?: number;
	    etaSeconds?: number;
	    message?: string;
	    startedAtMs?: number;
	    updatedAtMs?: number;
	    finishedAtMs?: number;
	
	    static createFrom(source: any = {}) {
	        return new TransferUpdate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.profileName = source["profileName"];
	        this.type = source["type"];
	        this.status = source["status"];
	        this.name = source["name"];
	        this.bucket = source["bucket"];
	        this.key = source["key"];
	        this.localPath = source["localPath"];
	        this.parentId = source["parentId"];
	        this.isGroup = source["isGroup"];
	        this.fileCount = source["fileCount"];
	        this.doneCount = source["doneCount"];
	        this.successCount = source["successCount"];
	        this.errorCount = source["errorCount"];
	        this.totalBytes = source["totalBytes"];
	        this.doneBytes = source["doneBytes"];
	        this.speedBytesPerSec = source["speedBytesPerSec"];
	        this.etaSeconds = source["etaSeconds"];
	        this.message = source["message"];
	        this.startedAtMs = source["startedAtMs"];
	        this.updatedAtMs = source["updatedAtMs"];
	        this.finishedAtMs = source["finishedAtMs"];
	    }
	}

}

