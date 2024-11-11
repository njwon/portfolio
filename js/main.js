let currentSection = 0;
let about = document.querySelector('.about')
let touchStartY = 0; // 터치 시작 Y 좌표
let scrolling = false; // 스크롤 제어 플래그
let currentVideoIndex = 0;
let aaa = 0;

const sections = document.querySelectorAll('.section');
const totalSections = sections.length;
const computedStyle = window.getComputedStyle(sections[currentSection]);
const height = computedStyle.height; // CSS에서 지정한 높이 가져오기
const Click = 0
const potato = document.querySelectorAll('.potato')
const c = document.querySelectorAll('.c')
const py = document.querySelectorAll('.python')
const nav1 = document.querySelectorAll('.nav1')
const nav2 = document.querySelectorAll('.nav2')
const nav3 = document.querySelectorAll('.nav3')
const mac = document.querySelectorAll('.mac')
const project_left = document.querySelectorAll('.project-left')


const cursorPointed = document.querySelector('.cursor');

const width = window.innerWidth;

if (cursorPointed) {
    const moveCursor = (e) => {
        const mouseY = e.clientY;
        const mouseX = e.clientX;
        cursorPointed.style.left = `${mouseX}px`;
        cursorPointed.style.top = `${mouseY}px`;
    };

    const updateCursorVisibility = () => {
        if (window.innerWidth > 1279) {
            cursorPointed.style.display = 'block';
            window.addEventListener('mousemove', moveCursor);
        } else {
            cursorPointed.style.display = 'none';
            window.removeEventListener('mousemove', moveCursor); // 크기 조정 시 이벤트 제거
        }
    };

    updateCursorVisibility(); // 처음 로드 시 한 번 호출
    window.addEventListener('resize', updateCursorVisibility); // 윈도우 크기 변경 시 호출
}

window.addEventListener('load', () => {
    // 로딩 완료 후 로더 사라지기
    load.style.opacity = '0'; // 투명도 변경
    load.style.zIndex = '10003';

    setTimeout(() => {
        load.style.zIndex = '-1'; // z-index 변경
        load.style.display = 'none'; // 로더 숨기기
    }, 10000); // 애니메이션 시간과 동일하게 설정
});

// 방향키를 통해 currentSection 조절
document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') {
        // 아래 방향키를 통해 currentSection -1
        if (currentSection < totalSections - 1) {
            currentSection++;
            scrollToSection(currentSection);
        }
    }
    else if (event.key === 'ArrowUp') {
        // 아래 방향키를 통해 currentSection +1
        if (currentSection > 0) {
            currentSection--;
            scrollToSection(currentSection);
        }
    }
});

document.addEventListener('wheel', (event) => {
    if (scrolling) return; // 이미 스크롤 중이라면 무시
    scrolling = true; // 스크롤 시작

    if (event.deltaY > 0) {
        // 아래로 스크롤
        handleScrollDown();
    } else {
        // 위로 스크롤
        handleScrollUp();
    }
});

// 터치 이벤트
document.addEventListener('touchstart', (event) => {
    // 터치 시작 Y 좌표 저장
    touchStartY = event.touches[0].clientY;
});

document.addEventListener('touchend', (event) => {
    const touchEndY = event.changedTouches[0].clientY;
    const touchDifference = touchStartY - touchEndY;

    if (Math.abs(touchDifference) > 30) { // 터치 이동이 충분히 컸을 경우
        if (touchDifference > 0) {
            // 아래로 스크롤
            handleScrollDown();
        } else {
            // 위로 스크롤
            handleScrollUp();
        }
    }
});

function handleScrollDown() {
    if (currentSection === 1) {
        if (about.scrollHeight - about.clientHeight <= about.scrollTop + 5) {
            currentSection++;
            scrollToSection(currentSection);
        }
    } else if (currentSection < totalSections - 1) {
        currentSection++;
        scrollToSection(currentSection);
    }
    scrolling = false; // 스크롤 종료
}

function handleScrollUp() {
    if (currentSection === 1) {
        if (about.scrollTop <= 5) {
            currentSection--;
            scrollToSection(currentSection);
        }
    } else if (currentSection > 0) {
        currentSection--;
        scrollToSection(currentSection);
    }
    scrolling = false; // 스크롤 종료
}

// scrollToSection은 섹션으로 부드럽게 이동하는 함수입니다.
function scrollToSection(sectionIndex) {
    const targetSection = sections[sectionIndex];
    targetSection.scrollIntoView({ behavior: 'smooth' });
}


window.onload = function () {
    // 새로고침시 제일 위로 스크롤
    window.scrollTo(0, 0);
    currentSection = 0;
    scrollToSection(currentSection);
};

// 마지막 섹션에서 스크롤 방지
document.addEventListener('touchmove', (event) => {
    if (currentSection === totalSections - 1) {
        event.preventDefault();
    }
}, { passive: false });


function setSection(index) {
    currentSection = index; // 클릭된 인덱스를 currentSection에 설정
    scrollToSection(currentSection); // 해당 섹션으로 스크롤
}

function scrollToSection(index) {
    sections.forEach((section, i) => {
        // if (currentSection === 2 || currentSection === 4) {
        //     section.style.transform = `translateY(-${index * 100}vh - 30px)`;
        // }
        // else {
        section.style.transform = `translateY(-${index * 100}vh)`;
        // }
    });
}

const videos = [
    'img/home/core1.webm',
    'img/home/core2.webm',
    'img/home/core3.webm'
];

function changeVideo() {
    const videoElement = document.getElementById('tvVideo');
    videoElement.pause(); // 현재 영상 멈추기

    // 다음 영상 불러오기
    currentVideoIndex = (currentVideoIndex + 1) % videos.length;
    videoElement.src = videos[currentVideoIndex];
    videoElement.load(); // currentVideoIndex 불러오기

    // 영상 로딩되면 재생
    videoElement.onloadeddata = () => {
        videoElement.play(); // 영상 재생
    };
}

function updateDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // 월은 0부터 시작
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const formattedDateTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    document.getElementById('datetime').innerText = formattedDateTime;

    const formattedDateTime2 = `${year}년 ${month}월 ${day}일`;
    document.getElementById('datetime2').innerText = formattedDateTime2;
}

setInterval(updateDateTime, 1000);
updateDateTime(); // 초기 호출

const onScroll = (event) => {
    event.preventDefault();

    if (!isDone) {
        if (event.deltaY > 0) {
            if (currentIndex === texts.length - 1) {
                isDone = true;
                document.body.style.overflow = 'unset';
            } else {
                changeText(1);
            }
        } else {
            if (currentIndex > 0) {
                changeText(-1);
            }
        }
    }
};

const wrap = document.querySelector('.wrap');
const card_box = document.querySelector('.card_box');

wrap.addEventListener('click', () => {
    wrap.classList.toggle('spread');
});

const onTouchStart = (event) => {
    startY = event.touches[0].clientY;
};

const onTouchMove = (event) => {
    const deltaY = startY - event.touches[0].clientY;

    if (!isDone && Math.abs(deltaY) > 50) {
        if (deltaY > 0) {
            if (currentIndex === texts.length - 1) {
                isDone = true;
                document.body.style.overflow = 'unset';
            } else {
                changeText(1);
            }
        } else {
            if (currentIndex > 0) {
                changeText(-1);
            }
        }
        event.preventDefault();
    }
};

function changeText1() {
    mac.forEach(mac => {
        mac.classList.remove('window');
    });
    project_left.forEach(project_left => {
        project_left.classList.remove('black');
    });
    project_left.forEach(project_left => {
        project_left.classList.add('white');
    });
    potato.forEach(potato => {
        potato.classList.remove('none');
    });
    nav1.forEach(nav1 => {
        nav1.classList.remove('none');
    });
    mac.forEach(mac => {
        mac.classList.add('window1');
    });
    c.forEach(c => {
        c.classList.add('none');
    });
    nav2.forEach(nav2 => {
        nav2.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window2');
    });
    py.forEach(py => {
        py.classList.add('none');
    });
    nav3.forEach(nav3 => {
        nav3.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window3');
    });
}

function changeText2() {
    mac.forEach(mac => {
        mac.classList.remove('window');
    });
    project_left.forEach(project_left => {
        project_left.classList.remove('black');
    });
    project_left.forEach(project_left => {
        project_left.classList.add('white');
    });
    potato.forEach(potato => {
        potato.classList.add('none');
    });
    nav1.forEach(nav1 => {
        nav1.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window1');
    });
    c.forEach(c => {
        c.classList.remove('none');
    });
    nav2.forEach(nav2 => {
        nav2.classList.remove('none');
    });
    mac.forEach(mac => {
        mac.classList.add('window2');
    });
    py.forEach(py => {
        py.classList.add('none');
    });
    nav3.forEach(nav3 => {
        nav3.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window3');
    });
}

function changeText3() {
    mac.forEach(mac => {
        mac.classList.remove('window');
    });
    project_left.forEach(project_left => {
        project_left.classList.remove('black');
    });
    project_left.forEach(project_left => {
        project_left.classList.add('white');
    });
    potato.forEach(potato => {
        potato.classList.add('none');
    });
    nav1.forEach(nav1 => {
        nav1.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window1');
    });
    c.forEach(c => {
        c.classList.add('none');
    });
    nav2.forEach(nav2 => {
        nav2.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window2');
    });
    py.forEach(py => {
        py.classList.remove('none');
    });
    nav3.forEach(nav3 => {
        nav3.classList.remove('none');
    });
    mac.forEach(mac => {
        mac.classList.add('window3');
    });
}

function changeText4() {
    mac.forEach(mac => {
        mac.classList.add('window');
    });
    project_left.forEach(project_left => {
        project_left.classList.add('black');
    });
    project_left.forEach(project_left => {
        project_left.classList.remove('white');
    });
    potato.forEach(potato => {
        potato.classList.add('none');
    });
    nav1.forEach(nav1 => {
        nav1.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window1');
    });
    c.forEach(c => {
        c.classList.add('none');
    });
    nav2.forEach(nav2 => {
        nav2.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window2');
    });
    py.forEach(py => {
        py.classList.add('none');
    });
    nav3.forEach(nav3 => {
        nav3.classList.add('none');
    });
    mac.forEach(mac => {
        mac.classList.remove('window3');
    });
}

function checkBottomBar() {
    // 화면의 전체 높이 (뷰포트 크기)
    const windowHeight = window.innerHeight;
    // 문서의 높이 (스크롤 포함된 전체 내용 높이)
    const docHeight = document.documentElement.scrollHeight;
    // 현재 보이는 화면 영역 높이 (스크롤 제외된 부분)
    const viewportHeight = document.documentElement.clientHeight;

    // 하단바가 보이는지 여부 판단
    // 1. 화면 높이가 문서의 총 높이보다 작고, 
    // 2. window.innerHeight와 document.documentElement.clientHeight가 다르면 하단바가 보이는 것으로 판단
    if (windowHeight < docHeight && windowHeight !== viewportHeight) {
        console.log('하단바가 보이고 있습니다.');
        aaa = 1;
        document.body.classList.add('bottom-bar-visible');  // 하단바가 있을 때 스타일 적용 (예시)
    } else {
        console.log('하단바가 숨겨져 있습니다.');
        aaa = 2;
        document.body.classList.remove('bottom-bar-visible');  // 하단바가 없을 때 스타일 적용
    }
}

// 화면 크기 변경 시마다 하단바 상태 확인
window.addEventListener('resize', checkBottomBar);

// 초기 상태 확인
checkBottomBar();
