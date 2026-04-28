DROP DATABASE IF EXISTS MSWCS;

DROP ROLE IF EXISTS
    'role_admin',
    'role_commander',
    'role_operator',
    'role_auditor';

DROP USER IF EXISTS
    'admin_choi'@'localhost',
    'commander_lee'@'localhost',
    'auditor_park'@'localhost',
    '123123'@'localhost',
    'operator_kim'@'localhost';

CREATE DATABASE MSWCS;

USE MSWCS;

-- 1.1 (사용자 식별): 시스템은 모든 접근 시도에 대해 사용자를 식별해야 한다.
-- 보안을 위한 모든 활동 기록
SET GLOBAL general_log = 'ON';
SET GLOBAL log_output = 'TABLE'; 

SELECT event_time, user_host, command_type, argument
FROM mysql.general_log
ORDER BY event_time DESC;

-- 1. 마스터 테이블 (다른 테이블이 참조하는, 의존성 없는 테이블)
-- 1-1. personnel (인원)
CREATE TABLE personnel (
    id INT PRIMARY KEY AUTO_INCREMENT,
    uuid CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()), -- 외부용 보안 ID (UK)
    name VARCHAR(100) NOT NULL, -- 반드시 DB user name만 삽입
    `rank` ENUM('Commander', 'Operator', 'Admin', 'Auditor') NOT NULL,
    clearance_level INT NOT NULL,
    status ENUM('active', 'on_leave', 'retired') NOT NULL DEFAULT 'active'
);

-- 1-2. weapon_system (무기 시스템)
CREATE TABLE weapon_system (
    id INT PRIMARY KEY AUTO_INCREMENT,
    uuid CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()), -- 외부용 보안 ID (UK)
    name VARCHAR(50) NOT NULL,
    type ENUM('missile','drone','radar','defense_grid') NOT NULL,
    status ENUM('active','maintenance','standby') NOT NULL DEFAULT 'standby',
    security_level INT NOT NULL
);


-- 2. 트랜잭션 테이블 (마스터 테이블을 참조하는, 의존성 있는 테이블)
-- 2-1. control_code (제어 코드)
CREATE TABLE control_code (
    id INT PRIMARY KEY AUTO_INCREMENT,
    uuid CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    weapon_system_id INT NOT NULL,
    code_hash CHAR(64) NOT NULL UNIQUE,
    issued_by_id INT NOT NULL,
    valid_from DATETIME NOT NULL,
    valid_to DATETIME NOT NULL,
    
    FOREIGN KEY (weapon_system_id) REFERENCES weapon_system(id),
    FOREIGN KEY (issued_by_id) REFERENCES personnel(id)
);

-- 2-2. operation_log (작전 로그)
CREATE TABLE operation_log (
    id INT PRIMARY KEY AUTO_INCREMENT,
    uuid CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    weapon_system_id INT NOT NULL,
    control_code_id INT NOT NULL,
    operator_id INT NOT NULL,
    timestamp DATETIME NOT NULL,
    action ENUM('test','launch','maintenance') NOT NULL,
    result ENUM('succeeded','failed'),
    
    FOREIGN KEY (weapon_system_id) REFERENCES weapon_system(id),
    FOREIGN KEY (control_code_id) REFERENCES control_code(id),
    FOREIGN KEY (operator_id) REFERENCES personnel(id)
);
CREATE TABLE control_code_archive (
	id INT PRIMARY KEY AUTO_INCREMENT,
    code_id INT NOT NULL UNIQUE, -- 원본 ID
    uuid CHAR(36) NOT NULL UNIQUE,
    weapon_system_id INT NOT NULL,
    code_hash CHAR(64) NOT NULL,
    issued_by_id INT NOT NULL,
    valid_from DATETIME NOT NULL,
    valid_to DATETIME NOT NULL,
    archived_at DATETIME NOT NULL DEFAULT NOW()
);

-- 기능 구현(트리거와 프로시저)

-- 시스템은 control_code 원문이 아닌, 해시된 값(code_hash)만을 저장해야 한다.
-- 코드 발급 시, 반드시 valid_from (유효 시작)과 valid_to (유효 종료) 시간을 설정해야 한다.
DELIMITER $$

CREATE TRIGGER trg_code_insert
BEFORE INSERT ON control_code
FOR EACH ROW
BEGIN
    -- 1. code_hash SHA-256 형식 검증
    IF NEW.code_hash NOT REGEXP '^[0-9a-fA-F]{64}$' THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = '해시 포맷이 맞지 않습니다: 64개의 헥스 문자를 추가하세요 (SHA-256)';
    END IF;

    IF NEW.valid_from IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'valid_from은 NULL일 수 없습니다.';
    END IF;

    IF NEW.valid_to IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'valid_to는 NULL일 수 없습니다.';
    END IF;

    IF NEW.valid_from >= NEW.valid_to THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'valid_to는 valid_from 보다 이를 수 없습니다.';
    END IF;
END$$

DELIMITER ;

DELIMITER $$

CREATE TRIGGER trg_check_db_user_name_before_insert
BEFORE INSERT ON personnel
FOR EACH ROW
BEGIN
    DECLARE user_exists INT;

    SELECT COUNT(*) INTO user_exists
    FROM mysql.user
    WHERE user = NEW.name;

    IF user_exists = 0 THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'personnel 테이블에 삽입된 이름이 현재 DB에 등록된 유저명이 아닙니다.';
    END IF;
END$$

DELIMITER ;

-- 만료된 코드 아카이브화 및 기존 테이블에서 제거
DELIMITER $$
CREATE PROCEDURE archive_expired_control_codes()
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK; 
        SIGNAL SQLSTATE '45000' 
            SET MESSAGE_TEXT = '아카이빙 중 데이터 오류가 발생하여 트랜잭션이 롤백되었습니다.';
    END;

    START TRANSACTION;
    CREATE TEMPORARY TABLE IF NOT EXISTS temp_archive_codes AS
    SELECT id, uuid, weapon_system_id, code_hash, issued_by_id, valid_from, valid_to
    FROM control_code
    WHERE valid_to < NOW();

    IF EXISTS (
        SELECT T.id
        FROM temp_archive_codes T
        JOIN control_code_archive A ON T.id = A.code_id
    ) THEN
        DROP TEMPORARY TABLE temp_archive_codes;
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = '아카이브 테이블에 중복되는 원본 코드 ID가 존재하여 작업을 취소합니다.';
    END IF;

    INSERT INTO control_code_archive (
        code_id, uuid, weapon_system_id, code_hash, issued_by_id, valid_from, valid_to
    )
    SELECT 
        id, uuid, weapon_system_id, code_hash, issued_by_id, valid_from, valid_to
    FROM control_code
    WHERE valid_to < NOW();

    DELETE FROM control_code
    WHERE valid_to < NOW();

    COMMIT;
END$$

DELIMITER ;

-- 작전 수행 및 수행 시 3가지 조건 검증
DELIMITER $$

CREATE PROCEDURE operation(
    IN p_weapon_system_id INT,
    IN p_control_code CHAR(64),
    IN p_action ENUM('test','launch','maintenance')
)
BEGIN
	DECLARE v_control_code_id INT;
    DECLARE v_operator_id INT;
    DECLARE v_valid_from DATETIME;
    DECLARE v_valid_to DATETIME;
    DECLARE v_weapon_id INT;

    SET v_control_code_id = NULL;
    SELECT id INTO v_operator_id
    FROM personnel
    WHERE name = SUBSTRING_INDEX(SESSION_USER(), '@', 1)
    LIMIT 1;

	SET v_control_code_id = NULL;
    SELECT id INTO v_control_code_id
    FROM control_code
    WHERE code_hash = p_control_code;
    
	IF v_control_code_id IS NULL THEN
        SIGNAL SQLSTATE '45000' 
        SET MESSAGE_TEXT = '코드가 control_code 테이블에 존재하지 않습니다.';
    END IF;

    SELECT weapon_system_id, valid_from, valid_to
    INTO v_weapon_id, v_valid_from, v_valid_to
    FROM control_code
    WHERE id = v_control_code_id
    LIMIT 1;

    IF v_weapon_id <> p_weapon_system_id THEN
        INSERT INTO operation_log (
            weapon_system_id,
            control_code_id,
            operator_id,
            timestamp,
            action,
            result
        ) VALUES (
            p_weapon_system_id,
            v_control_code_id,
            v_operator_id,
            NOW(),
            p_action,
            'failed'
        );
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'weapon_system_id가 맞지 않습니다.';
    END IF;

    IF NOW() < v_valid_from OR NOW() > v_valid_to THEN
        INSERT INTO operation_log (
            weapon_system_id,
            control_code_id,
            operator_id,
            timestamp,
            action,
            result
        ) VALUES (
            p_weapon_system_id,
            v_control_code_id,
            v_operator_id,
            NOW(),
            p_action,
            'failed'
        );
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'control_code가 유효기간을 벗어납니다.';
    END IF;

    INSERT INTO operation_log (
        weapon_system_id,
        control_code_id,
        operator_id,
        timestamp,
        action,
        result
    ) VALUES (
        p_weapon_system_id,
        v_control_code_id,
        v_operator_id,
        NOW(),
        p_action,
        'succeeded'
    );

END$$
DELIMITER ;

-- Commander(지휘관) control_code 생성
DELIMITER $$
CREATE PROCEDURE create_control_code(
    IN p_weapon_system_id INT,
    IN p_control_code CHAR(64),
    IN p_valid_to_input DATETIME 
)
BEGIN
    DECLARE v_valid_to DATETIME;
    DECLARE v_commander_name VARCHAR(100);
    DECLARE v_id_exists INT DEFAULT 0;
    DECLARE v_code_duplicate INT DEFAULT 0;
    DECLARE v_commander_id INT;
    DECLARE v_commander_status VARCHAR(20);

    SET v_commander_name = SUBSTRING_INDEX(SESSION_USER(), '@', 1);
    
    SELECT id, status
    INTO v_commander_id, v_commander_status
    FROM personnel
    WHERE name = v_commander_name
    LIMIT 1;
    

    IF v_commander_id IS NULL THEN
        SIGNAL SQLSTATE '45000' 
        SET MESSAGE_TEXT = 'Personnel 테이블에 등록된 지휘관이 아닙니다.';
    END IF;

    IF v_commander_status != 'active' THEN
        SIGNAL SQLSTATE '45000' 
        SET MESSAGE_TEXT = '지휘관 계정 상태가 비활성이므로 제어 코드를 생성할 수 없습니다.';
    END IF;

    SELECT COUNT(*)
    INTO v_id_exists
    FROM weapon_system
    WHERE id = p_weapon_system_id;

    IF v_id_exists = 0 THEN
        SIGNAL SQLSTATE '45000' 
        SET MESSAGE_TEXT = '제공한 weapon_system_id가 존재하지 않습니다.';
    END IF;

    SELECT COUNT(*)
    INTO v_code_duplicate
    FROM control_code
    WHERE weapon_system_id = p_weapon_system_id
      AND valid_to > NOW(); 

    IF v_code_duplicate > 0 THEN
        SIGNAL SQLSTATE '45000' 
        SET MESSAGE_TEXT = '이 무기 시스템에 유효기간이 남은 활성 컨트롤 코드가 이미 존재합니다.';
    END IF;

    IF p_valid_to_input IS NULL THEN
        SET v_valid_to = DATE_ADD(NOW(), INTERVAL 1 YEAR);
    ELSE
        SET v_valid_to = p_valid_to_input;
    END IF;

    INSERT INTO control_code (
        weapon_system_id, 
        code_hash, 
        issued_by_id, 
        valid_from, 
        valid_to 
    ) VALUES (
        p_weapon_system_id, 
        p_control_code, 
        v_commander_id, 
        NOW(), 
        v_valid_to
    );

END$$

DELIMITER ;

-- 감사관 필터링
DROP PROCEDURE IF EXISTS operation_log_filter;
DELIMITER $$

CREATE PROCEDURE operation_log_filter(
    IN p_filter_column VARCHAR(100),
    IN p_filter_value VARCHAR(100),
    IN p_order_column VARCHAR(100),
    IN p_order_dir ENUM('asc','desc')
)
BEGIN
    DECLARE allowed_filter_columns VARCHAR(500) DEFAULT 'uuid,weapon_system_id,control_code_id,operator_id,action,result';
    DECLARE allowed_order_columns VARCHAR(500) DEFAULT 'timestamp,action,result,id';

    IF p_filter_column IS NULL OR p_filter_column = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'p_filter_column은 비워질 수 없습니다.';
    END IF;
    
    IF FIND_IN_SET(p_filter_column, allowed_filter_columns) = 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '허용되지 않은 필터 컬럼입니다.';
    END IF;

    IF p_filter_value IS NULL OR p_filter_value = '' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'p_filter_value는 비워질 수 없습니다.';
    END IF;

    SET @v_sql = CONCAT(
        'SELECT * FROM operation_log WHERE ',
        p_filter_column, ' = ?'
    );

    IF p_order_column IS NOT NULL AND p_order_column <> '' THEN
        IF FIND_IN_SET(p_order_column, allowed_order_columns) = 0 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '허용되지 않은 정렬 컬럼입니다.';
        END IF;

        IF p_order_dir IN ('asc','desc') THEN
            SET @v_sql = CONCAT(
                @v_sql, ' ORDER BY ', p_order_column, ' ', UPPER(p_order_dir)
            );
        ELSE
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'p_order_dir은 asc, desc 중 하나여야 합니다.';
        END IF;
    END IF;

    SET @p_value = p_filter_value;
    PREPARE stmt FROM @v_sql;
    EXECUTE stmt USING @p_value;
    DEALLOCATE PREPARE stmt;
END$$

DELIMITER ;


CREATE ROLE 
    'role_admin',      -- 관리자
    'role_commander',  -- 지휘관
    'role_auditor',    -- 감사관
    'role_operator';   -- 조작원

-- 1. 조작원 (Operator)
-- : 작전을 수행할 권한
GRANT SELECT 
    ON MSWCS.weapon_system 
    TO 'role_operator';
GRANT SELECT 
    ON MSWCS.control_code 
    TO 'role_operator';
GRANT EXECUTE ON PROCEDURE MSWCS.operation TO 'role_operator';

-- 2. 지휘관 (Commander)
-- : control_code 발급(INSERT) 및 operation_log, weapon_system 조회(SELECT) 권한
GRANT INSERT 
    ON MSWCS.control_code 
    TO 'role_commander';
GRANT SELECT 
    ON MSWCS.operation_log 
    TO 'role_commander';
GRANT SELECT 
    ON MSWCS.weapon_system 
    TO 'role_commander';
GRANT EXECUTE ON PROCEDURE mswcs.create_control_code TO 'role_commander';

GRANT role_operator TO role_commander;

-- 3. 감사관 (Auditor)
-- : 모든 테이블의 모든 기록 조회(SELECT) 권한
GRANT SELECT 
    ON MSWCS.operation_log 
    TO 'role_auditor';
-- (참고) 로그의 ID만 보면 의미를 알 수 없으므로, 모든 테이블 조회 권한 부여
GRANT SELECT 
    ON MSWCS.personnel 
    TO 'role_auditor';
GRANT SELECT 
    ON MSWCS.weapon_system 
    TO 'role_auditor';
GRANT SELECT 
    ON MSWCS.control_code 
    TO 'role_auditor';
GRANT EXECUTE ON PROCEDURE MSWCS.operation_log_filter TO 'role_auditor';

-- 4. 관리자 (Admin)
-- : 모든 테이블의 등록 및 상태 변경(유지보수 등) 권한.
GRANT SELECT, INSERT, UPDATE, DELETE 
    ON MSWCS.weapon_system 
    TO 'role_admin';
GRANT SELECT, INSERT, UPDATE, DELETE 
    ON MSWCS.personnel 
    TO 'role_admin';
GRANT SELECT, INSERT, UPDATE, DELETE 
    ON MSWCS.control_code 
    TO 'role_admin';
GRANT SELECT, INSERT
    ON MSWCS.operation_log 
    TO 'role_admin';
GRANT SELECT, INSERT, UPDATE, DELETE 
    ON MSWCS.control_code_archive 
    TO 'role_admin';
GRANT EXECUTE ON PROCEDURE MSWCS.archive_expired_control_codes TO 'role_admin';
GRANT role_commander TO role_admin;
GRANT role_auditor TO role_admin;

/* ---------------------------------------------------
 3. (보안 강화) 로그 불변성(Immutability) 적용
    - operation_log는 한 번 쓰이면 절대 수정/삭제 불가
    - 모든 역할(심지어 관리자)에게도 UPDATE, DELETE 권한을 금지
---------------------------------------------------
*/


/* ---------------------------------------------------
 4. 사용자(User) 생성 및 역할 부여 예시
    - 실제 인원에게 위에서 만든 역할을 할당
---------------------------------------------------
*/
-- 4-1. 사용자 계정 생성
CREATE USER 'admin_choi'@'localhost' IDENTIFIED BY '123';
CREATE USER 'commander_lee'@'localhost' IDENTIFIED BY '123';
CREATE USER 'operator_kim'@'localhost' IDENTIFIED BY '123';
CREATE USER 'auditor_park'@'localhost' IDENTIFIED BY '123';
CREATE USER '123123'@'localhost' IDENTIFIED BY '123';

-- 4-2. 사용자에게 역할 부여
GRANT 'role_admin' TO 'admin_choi'@'localhost';
GRANT 'role_commander' TO 'commander_lee'@'localhost';
GRANT 'role_operator' TO 'operator_kim'@'localhost';
GRANT 'role_auditor' TO 'auditor_park'@'localhost';
GRANT 'role_auditor' TO '123123'@'localhost';

-- GRANT 'role_admin' TO 'root'@'localhost';

-- 4-3. (중요) 해당 역할을 기본 역할로 활성화
SET DEFAULT ROLE 'role_admin' TO 'admin_choi'@'localhost';
SET DEFAULT ROLE 'role_commander' TO 'commander_lee'@'localhost';
SET DEFAULT ROLE 'role_operator' TO 'operator_kim'@'localhost';
SET DEFAULT ROLE 'role_auditor' TO 'auditor_park'@'localhost';

FLUSH PRIVILEGES;

INSERT INTO personnel (name, `rank`, clearance_level, status)
VALUES
('operator_kim', 'Operator', 3, 'active'),
('commander_lee', 'Commander', 2, 'active'),
('admin_choi', 'Admin', 1, 'active'),
('auditor_park', 'Auditor', 2, 'active');


INSERT INTO weapon_system (name, type, status, security_level)
VALUES
('Aegis-01', 'radar', 'active', 3),
('Drone-X7', 'drone', 'standby', 2),
('Missile-K2', 'missile', 'active', 1);

INSERT INTO control_code (
    weapon_system_id,
    code_hash,
    issued_by_id,
    valid_from,
    valid_to
)
VALUES
(1, 'a3f1c5b9d9f0a1c23d4e5f60718293abccddeeff11223344556677889900aa11', 2,
    '2025-01-01 00:00:00', '2025-12-31 23:59:59'),

(2, 'bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899cc33', 2,
    '2025-05-01 00:00:00', '2025-11-01 23:59:59'),

(3, 'ffeeddccbbaa0099887766554433221100ffeeddccbbaa998877665544332211', 2,
    '2025-02-15 00:00:00', '2025-09-30 23:59:59');







