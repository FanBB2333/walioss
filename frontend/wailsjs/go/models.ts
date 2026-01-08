export namespace main {

	export class AppSettings {
		ossutilPath: string;
		defaultRegion: string;
		defaultEndpoint: string;
		theme: string;

		static createFrom(source: any = {}) {
			return new AppSettings(source);
		}

		constructor(source: any = {}) {
			if ('string' === typeof source) source = JSON.parse(source);
			this.ossutilPath = source["ossutilPath"];
			this.defaultRegion = source["defaultRegion"];
			this.defaultEndpoint = source["defaultEndpoint"];
			this.theme = source["theme"];
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

}

